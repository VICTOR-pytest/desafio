import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../domain/wager/failure-code';
import { WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { WagerProcessor } from '../domain/wager-processor/wager-processor';
import { balanceChangedEvent, transactionEvent } from './events';
import {
  ClaimedPendingReference,
  NOOP_TELEMETRY,
  PendingReferenceStore,
  Telemetry,
  UnitOfWork,
} from './ports';
import { withBoundedRetry } from './retry';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  leaseMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
}

export const DEFAULT_PENDING_WORKER_OPTIONS: PendingReferenceWorkerOptions = {
  batchSize: 20,
  leaseMs: 30_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 5 * 60_000,
  maxAttempts: 50,
};

export interface PendingRunSummary {
  processed: number;
  rejected: number;
  stillPending: number;
  expired: number;
  skipped: number;
}

type Outcome = keyof PendingRunSummary;

export class ResolvePendingReferencesUseCase {
  private readonly options: PendingReferenceWorkerOptions;

  constructor(
    private readonly store: PendingReferenceStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerProcessor = new WagerProcessor(),
    options: Partial<PendingReferenceWorkerOptions> = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {
    this.options = { ...DEFAULT_PENDING_WORKER_OPTIONS, ...options };
  }

  async runOnce(): Promise<PendingRunSummary> {
    const claimed = await this.store.claimDue({
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
      now: this.clock(),
    });
    const summary: PendingRunSummary = {
      processed: 0,
      rejected: 0,
      stillPending: 0,
      expired: 0,
      skipped: 0,
    };

    for (const item of claimed) {
      const outcome = await withBoundedRetry(() => this.resolve(item));
      summary[outcome]++;
      this.telemetry.metrics.increment('pending_reference_runs_total', {
        outcome,
      });
    }

    return summary;
  }

  private resolve(item: ClaimedPendingReference): Promise<Outcome> {
    return this.unitOfWork.run(async (context): Promise<Outcome> => {
      const now = this.clock();
      const wallet = await context.wallets.lockById(item.walletId);
      const stored = await context.transactions.lockById(item.transactionId);

      if (
        !wallet ||
        !stored ||
        stored.transaction.status !== WagerTransactionStatus.PENDING_REFERENCE
      ) {
        return 'skipped';
      }

      const transaction = stored.transaction;
      const eventContext = {
        correlationId: stored.correlationId,
        causationId: transaction.id,
        now,
      };
      const reference = transaction.referenceExternalTransactionId
        ? await context.transactions.findByExternalId(
            transaction.provider,
            transaction.referenceExternalTransactionId,
          )
        : null;
      const alreadyReversed = reference
        ? await context.transactions.isReversed(
            reference.transaction.id,
            transaction.type,
          )
        : false;
      const versionBefore = wallet.version;

      let entry: WalletLedgerEntry | null = this.processor.process(
        transaction,
        wallet,
        { transaction: reference?.transaction ?? null, alreadyReversed },
      );
      let expired = false;

      if (transaction.status === WagerTransactionStatus.PENDING_REFERENCE) {
        const attempts = stored.pendingAttempts + 1;
        const due =
          (stored.pendingExpiresAt && now >= stored.pendingExpiresAt) ||
          attempts >= this.options.maxAttempts;

        if (!due) {
          const backoff = Math.min(
            this.options.baseBackoffMs * 2 ** attempts,
            this.options.maxBackoffMs,
          );

          await context.transactions.update(transaction, {
            pendingAttempts: attempts,
            pendingNextAttemptAt: new Date(now.getTime() + backoff),
          });
          return 'stillPending';
        }

        transaction.markRejected(FailureCode.PENDING_REFERENCE_EXPIRED, now);
        entry = null;
        expired = true;
      }

      await context.transactions.update(transaction, {
        pendingAttempts: stored.pendingAttempts + 1,
      });

      if (entry) {
        await context.ledger.insert(entry);
        await context.wallets.saveBalance(wallet, versionBefore);
      }

      await context.outbox.insert(transactionEvent(transaction, eventContext));

      if (entry) {
        await context.outbox.insert(
          balanceChangedEvent(wallet, entry, eventContext),
        );
      }

      this.telemetry.logger.info('pending reference resolved', {
        correlationId: stored.correlationId,
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: transaction.provider,
        status: transaction.status,
        failureCode: transaction.failureCode,
      });

      if (expired) {
        return 'expired';
      }

      return transaction.status === WagerTransactionStatus.PROCESSED
        ? 'processed'
        : 'rejected';
    });
  }
}

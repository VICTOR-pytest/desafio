import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/domain-error';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Money, MoneyProps } from '../domain/money/money';
import { FailureCode } from '../domain/wager/failure-code';
import {
  ExternalWagerTransactionType,
  WagerTransaction,
  WagerTransactionType,
} from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { WagerProcessor } from '../domain/wager-processor/wager-processor';
import { hashPayload } from './canonical-hash';
import { IdempotencyConflictError, RetryableError } from './errors';
import { balanceChangedEvent, transactionEvent } from './events';
import {
  InsertTransactionMeta,
  NOOP_TELEMETRY,
  ResponseSnapshot,
  StoredWagerTransaction,
  Telemetry,
  TransactionalContext,
  UnitOfWork,
  WalletSummary,
} from './ports';
import { withBoundedRetry } from './retry';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  provider: string;
  externalTransactionId: string;
  playerId: string;
  walletId?: string;
  roundId: string;
  type: `${ExternalWagerTransactionType}`;
  amount: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  inbox?: {
    source: string;
    messageId: string;
    payload: Record<string, unknown>;
  };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: ResponseSnapshot['status'];
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
  wallet: WalletSummary | null;
}

export interface PendingReferencePolicy {
  ttlMs: number;
  baseBackoffMs: number;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  baseBackoffMs: 1000,
};

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerProcessor = new WagerProcessor(),
    private readonly clock: () => Date = () => new Date(),
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly pendingPolicy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const key = command.idempotencyKey;

    if (
      typeof key !== 'string' ||
      !key.trim() ||
      key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'A chave de idempotência é obrigatória e deve ter no máximo 255 caracteres',
      );
    }

    this.buildTransaction(command);
    const payloadHash = this.hashCommand(command);
    const startedAt = process.hrtime.bigint();

    try {
      const result = await withBoundedRetry(
        () =>
          this.unitOfWork.run((context) =>
            this.handle(context, command, payloadHash),
          ),
        (error, attempt) => this.recordRetry(command, error, attempt),
      );

      this.recordOutcome(command, result);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        this.telemetry.metrics.increment('wager_idempotency_conflicts_total');
        this.telemetry.logger.warn('idempotency conflict', {
          ...this.logFields(command),
        });
      }
      throw error;
    } finally {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.telemetry.metrics.observe('wager_processing_duration_seconds', seconds);
    }
  }

  private async handle(
    context: TransactionalContext,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const now = this.clock();
    const transaction = this.buildTransaction(command);
    const eventContext = {
      correlationId: command.correlationId ?? null,
      causationId: command.causationId ?? command.idempotencyKey,
      now,
    };

    if (command.inbox) {
      await context.inbox.register({
        id: randomUUID(),
        source: command.inbox.source,
        messageId: command.inbox.messageId,
        payload: command.inbox.payload,
        receivedAt: now,
      });
    }

    const wallet = command.walletId
      ? await context.wallets.lockById(command.walletId)
      : await context.wallets.lockByPlayerAndCurrency(
          command.playerId,
          command.amount.currency,
        );

    const existing =
      (await context.transactions.findByIdempotencyKey(
        command.provider,
        command.idempotencyKey,
      )) ??
      (await context.transactions.findByExternalId(
        command.provider,
        command.externalTransactionId,
      ));

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }

      if (command.inbox) {
        await context.inbox.linkTransaction(
          command.inbox.source,
          command.inbox.messageId,
          existing.transaction.id,
        );
      }

      return this.replayResult(existing);
    }

    const versionBefore = wallet?.version ?? 0;
    let entry: WalletLedgerEntry | null = null;

    if (!wallet) {
      transaction.markRejected(FailureCode.WALLET_NOT_FOUND, now);
    } else {
      const reference = transaction.referenceExternalTransactionId
        ? await context.transactions.findByExternalId(
            command.provider,
            transaction.referenceExternalTransactionId,
          )
        : null;
      const alreadyReversed = reference
        ? await context.transactions.isReversed(
            reference.transaction.id,
            transaction.type,
          )
        : false;

      entry = this.processor.process(transaction, wallet, {
        transaction: reference?.transaction ?? null,
        alreadyReversed,
      });
    }

    const responseSnapshot: ResponseSnapshot = {
      status: transaction.status,
      failureCode: transaction.failureCode,
      wallet: wallet ? this.summarize(wallet) : null,
    };

    await context.transactions.insert(
      transaction,
      this.insertMeta(command, payloadHash, responseSnapshot, now),
    );

    if (wallet && entry) {
      await context.ledger.insert(entry);
      await context.wallets.saveBalance(wallet, versionBefore);
    }

    await context.outbox.insert(transactionEvent(transaction, eventContext));

    if (wallet && entry) {
      await context.outbox.insert(
        balanceChangedEvent(wallet, entry, eventContext),
      );
    }

    if (command.inbox) {
      await context.inbox.linkTransaction(
        command.inbox.source,
        command.inbox.messageId,
        transaction.id,
      );
    }

    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay: false,
      wallet: responseSnapshot.wallet,
    };
  }

  private insertMeta(
    command: ProcessWagerCommand,
    payloadHash: string,
    responseSnapshot: ResponseSnapshot,
    now: Date,
  ): InsertTransactionMeta {
    const pending =
      responseSnapshot.status === 'PENDING_REFERENCE'
        ? {
            expiresAt: new Date(now.getTime() + this.pendingPolicy.ttlMs),
            nextAttemptAt: new Date(
              now.getTime() + this.pendingPolicy.baseBackoffMs,
            ),
          }
        : null;

    return {
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      responseSnapshot,
      correlationId: command.correlationId ?? null,
      pending,
    };
  }

  private summarize(wallet: Wallet): WalletSummary {
    return {
      walletId: wallet.id,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private replayResult(stored: StoredWagerTransaction): ProcessWagerResult {
    const snapshot = stored.responseSnapshot;

    return {
      transactionId: stored.transaction.id,
      status: snapshot?.status ?? stored.transaction.status,
      failureCode: snapshot ? snapshot.failureCode : stored.transaction.failureCode,
      idempotentReplay: true,
      wallet: snapshot?.wallet ?? null,
    };
  }

  private buildTransaction(command: ProcessWagerCommand): WagerTransaction {
    if ((command.type as string) === WagerTransactionType.OPENING) {
      throw new DomainError(
        'INVALID_TRANSACTION_TYPE',
        'Tipo de transação não aceito como entrada externa',
      );
    }

    return WagerTransaction.receive({
      id: randomUUID(),
      provider: command.provider,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      roundId: command.roundId,
      type: command.type as ExternalWagerTransactionType,
      amount: Money.from(command.amount),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock(),
    });
  }

  private hashCommand(command: ProcessWagerCommand): string {
    return hashPayload({
      provider: command.provider,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      type: command.type,
      amount: command.amount.amount,
      currency: command.amount.currency,
      referenceExternalTransactionId:
        command.referenceExternalTransactionId ?? null,
    });
  }

  private recordRetry(
    command: ProcessWagerCommand,
    error: RetryableError,
    attempt: number,
  ): void {
    const reason = error.constraint ? 'unique_violation' : 'lock_conflict';

    this.telemetry.metrics.increment('wager_retries_total', { reason });

    if (!error.constraint) {
      this.telemetry.metrics.increment('wager_lock_conflicts_total');
    }

    this.telemetry.logger.warn('retrying transaction processing', {
      ...this.logFields(command),
      attempt,
      reason,
    });
  }

  private recordOutcome(
    command: ProcessWagerCommand,
    result: ProcessWagerResult,
  ): void {
    if (result.idempotentReplay) {
      this.telemetry.metrics.increment('wager_duplicates_total', {
        source: command.inbox ? 'queue' : 'http',
      });
    } else {
      this.telemetry.metrics.increment('wager_transactions_total', {
        status: result.status,
        type: command.type,
      });
    }

    this.telemetry.logger.info('transaction processed', {
      ...this.logFields(command),
      transactionId: result.transactionId,
      walletId: result.wallet?.walletId,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
  }

  private logFields(command: ProcessWagerCommand) {
    return {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      providerId: command.provider,
      externalTransactionId: command.externalTransactionId,
    };
  }
}

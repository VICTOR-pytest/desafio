import { Money, MoneyProps } from '../domain/money/money';
import { WalletIdNotFoundError } from './errors';
import { NOOP_TELEMETRY, Telemetry, UnitOfWork } from './ports';
import { isUuid } from './uuid';

export interface ReconciliationResult {
  walletId: string;
  status: 'CONSISTENT' | 'DISCREPANCY';
  materializedBalance: MoneyProps;
  ledgerBalance: MoneyProps;
  difference: MoneyProps;
  walletVersion: number;
  checkedAt: string;
  discrepancyId: string | null;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  execute(
    walletId: string,
    source: 'MANUAL' | 'SCHEDULED' = 'MANUAL',
  ): Promise<ReconciliationResult> {
    if (!isUuid(walletId)) {
      return Promise.reject(new WalletIdNotFoundError(walletId));
    }

    return this.unitOfWork.run(async (context) => {
      const snapshot = await context.reconciliation.snapshot(walletId);

      if (!snapshot) {
        throw new WalletIdNotFoundError(walletId);
      }

      const now = this.clock();
      const materialized = Money.fromCents(snapshot.materializedCents, snapshot.currency);
      const ledger = Money.fromCents(snapshot.ledgerCents, snapshot.currency);
      const difference = materialized.subtract(ledger);
      const consistent = difference.isZero();
      const discrepancyId = consistent
        ? null
        : await context.reconciliation.recordDiscrepancy(snapshot, source, now);

      this.telemetry.metrics.increment('wallet_reconciliations_total', {
        result: consistent ? 'consistent' : 'discrepancy',
      });

      if (!consistent) {
        this.telemetry.logger.error('wallet reconciliation discrepancy', {
          walletId,
          materializedCents: snapshot.materializedCents.toString(),
          ledgerCents: snapshot.ledgerCents.toString(),
          differenceCents: difference.toCents().toString(),
          discrepancyId,
        });
      }

      return {
        walletId,
        status: consistent ? 'CONSISTENT' : 'DISCREPANCY',
        materializedBalance: materialized.toJSON(),
        ledgerBalance: ledger.toJSON(),
        difference: difference.toJSON(),
        walletVersion: snapshot.walletVersion,
        checkedAt: now.toISOString(),
        discrepancyId,
      };
    });
  }
}

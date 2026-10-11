import { NOOP_TELEMETRY, ReconciliationStore, Telemetry } from './ports';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';

export interface ReconcileAllSummary {
  checked: number;
  discrepancies: number;
  failures: number;
}

const PAGE_SIZE = 100;

export class ReconcileAllWalletsUseCase {
  constructor(
    private readonly store: ReconciliationStore,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async runOnce(): Promise<ReconcileAllSummary> {
    const summary: ReconcileAllSummary = { checked: 0, discrepancies: 0, failures: 0 };
    let cursor: string | null = null;

    for (;;) {
      const ids = await this.store.listWalletIds(cursor, PAGE_SIZE);

      if (ids.length === 0) {
        return summary;
      }

      for (const walletId of ids) {
        try {
          const result = await this.reconcile.execute(walletId, 'SCHEDULED');
          summary.checked++;

          if (result.status === 'DISCREPANCY') {
            summary.discrepancies++;
          }
        } catch (error) {
          summary.failures++;
          this.telemetry.logger.error('scheduled reconciliation failed', {
            walletId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      cursor = ids[ids.length - 1];
    }
  }
}

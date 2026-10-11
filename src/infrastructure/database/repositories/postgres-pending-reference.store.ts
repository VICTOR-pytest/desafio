import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ClaimedPendingReference,
  PendingReferenceStore,
} from '../../../application/ports';
import { queryRows } from './sql';

export class PostgresPendingReferenceStore implements PendingReferenceStore {
  constructor(private readonly em: EntityManager) {}

  async claimDue(options: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedPendingReference[]> {
    const leaseUntil = new Date(options.now.getTime() + options.leaseMs);

    const rows = await this.em.transactional((tem) =>
      queryRows(
        tem as EntityManager,
        `update wager_transactions set pending_next_attempt_at = ?::timestamptz
         where id in (
           select id from wager_transactions
           where status = 'PENDING_REFERENCE' and wallet_id is not null
             and pending_next_attempt_at <= ?::timestamptz
           order by pending_next_attempt_at, id
           limit ?
           for update skip locked)
         returning id, wallet_id`,
        [leaseUntil.toISOString(), options.now.toISOString(), options.limit],
      ),
    );

    return rows.map((row) => ({
      transactionId: row.id,
      walletId: row.wallet_id,
    }));
  }
}

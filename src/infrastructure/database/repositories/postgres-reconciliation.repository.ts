import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ReconciliationRepository,
  ReconciliationSnapshot,
  ReconciliationStore,
} from '../../../application/ports';
import { queryRows } from './sql';

export class PostgresReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly em: EntityManager) {}

  async snapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    const [row] = await queryRows(
      this.em,
      `select w.id, w.currency, w.balance_in_cents::text as materialized, w.version::text as version,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount_in_cents else -l.amount_in_cents end), 0)::text as ledger
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ?
       group by w.id`,
      [walletId],
    );

    if (!row) {
      return null;
    }

    return {
      walletId: row.id,
      currency: row.currency,
      materializedCents: BigInt(row.materialized),
      ledgerCents: BigInt(row.ledger),
      walletVersion: Number(row.version),
    };
  }

  async recordDiscrepancy(
    snapshot: ReconciliationSnapshot,
    source: 'MANUAL' | 'SCHEDULED',
    now: Date,
  ): Promise<string> {
    const difference = snapshot.materializedCents - snapshot.ledgerCents;
    const [row] = await queryRows(
      this.em,
      `with inserted as (
         insert into reconciliation_discrepancies
           (id, wallet_id, materialized_balance_in_cents, ledger_balance_in_cents, difference_in_cents,
            wallet_version, source, detected_at)
         select ?, ?, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?, ?::timestamptz
         where not exists (
           select 1 from reconciliation_discrepancies
           where wallet_id = ? and materialized_balance_in_cents = ?::bigint
             and ledger_balance_in_cents = ?::bigint and wallet_version = ?::bigint)
         returning id)
       select id from inserted
       union all
       select id from reconciliation_discrepancies
       where wallet_id = ? and materialized_balance_in_cents = ?::bigint
         and ledger_balance_in_cents = ?::bigint and wallet_version = ?::bigint
       limit 1`,
      [
        randomUUID(),
        snapshot.walletId,
        snapshot.materializedCents.toString(),
        snapshot.ledgerCents.toString(),
        difference.toString(),
        snapshot.walletVersion,
        source,
        now.toISOString(),
        snapshot.walletId,
        snapshot.materializedCents.toString(),
        snapshot.ledgerCents.toString(),
        snapshot.walletVersion,
        snapshot.walletId,
        snapshot.materializedCents.toString(),
        snapshot.ledgerCents.toString(),
        snapshot.walletVersion,
      ],
    );

    return row.id;
  }
}

export class PostgresReconciliationStore implements ReconciliationStore {
  constructor(private readonly em: EntityManager) {}

  async listWalletIds(afterId: string | null, limit: number): Promise<string[]> {
    const rows = await queryRows(
      this.em,
      `select id from wallets where (?::uuid is null or id > ?::uuid) order by id limit ?`,
      [afterId, afterId, limit],
    );
    return rows.map((row) => row.id);
  }
}

import type { EntityManager } from '@mikro-orm/postgresql';
import { LedgerPageItem, LedgerRepository } from '../../../application/ports';
import { Money } from '../../../domain/money/money';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { parseTimestamp, queryRows, runStatement, timestampColumn } from './sql';

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await runStatement(
      this.em,
      `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, entry_type, direction, amount_in_cents, currency,
         balance_before_in_cents, balance_after_in_cents, created_at)
       values (?, ?, ?, ?, ?, ?::bigint, ?, ?::bigint, ?::bigint, ?::timestamptz)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.type,
        entry.direction,
        entry.amount.toCents().toString(),
        entry.amount.currency,
        entry.balanceBefore.toCents().toString(),
        entry.balanceAfter.toCents().toString(),
        entry.createdAt.toISOString(),
      ],
    );
  }

  async listByWallet(
    walletId: string,
    afterSequence: string | null,
    limit: number,
  ): Promise<LedgerPageItem[]> {
    const rows = await queryRows(
      this.em,
      `select sequence::text as sequence_text, id, transaction_id, entry_type, direction, currency,
              amount_in_cents::text as amount, balance_before_in_cents::text as before,
              balance_after_in_cents::text as after, ${timestampColumn('created_at')}
       from wallet_ledger_entries
       where wallet_id = ? and (?::bigint is null or sequence > ?::bigint)
       order by sequence
       limit ?`,
      [walletId, afterSequence, afterSequence, limit],
    );

    return rows.map((row) => ({
      sequence: row.sequence_text,
      entryId: row.id,
      transactionId: row.transaction_id,
      type: row.entry_type,
      direction: row.direction,
      amount: Money.fromCents(BigInt(row.amount), row.currency).toJSON(),
      balanceBefore: Money.fromCents(BigInt(row.before), row.currency).toJSON(),
      balanceAfter: Money.fromCents(BigInt(row.after), row.currency).toJSON(),
      createdAt: parseTimestamp(row.created_at) as Date,
    }));
  }
}

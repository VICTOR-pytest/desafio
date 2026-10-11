import type { EntityManager } from '@mikro-orm/postgresql';
import {
  InsertTransactionMeta,
  StoredWagerTransaction,
  TransactionUpdate,
  WagerTransactionRepository,
} from '../../../application/ports';
import { Money } from '../../../domain/money/money';
import { FailureCode } from '../../../domain/wager/failure-code';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from '../../../domain/wager/wager-transaction';
import {
  parseTimestamp,
  queryRows,
  Row,
  runStatement,
  timestampColumn,
} from './sql';

const COLUMNS = `id, provider, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, type, amount_in_cents::text as amount_in_cents, currency,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  response_snapshot, correlation_id, pending_attempts,
  ${timestampColumn('pending_expires_at')},
  ${timestampColumn('created_at')}, ${timestampColumn('processed_at')}`;

export class PostgresWagerTransactionRepository
  implements WagerTransactionRepository
{
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<StoredWagerTransaction | null> {
    return this.select('id = ?', [id], '');
  }

  lockById(id: string): Promise<StoredWagerTransaction | null> {
    return this.select('id = ?', [id], ' for update');
  }

  findByIdempotencyKey(
    provider: string,
    idempotencyKey: string,
  ): Promise<StoredWagerTransaction | null> {
    return this.select(
      'provider = ? and idempotency_key = ?',
      [provider, idempotencyKey],
      '',
    );
  }

  findByExternalId(
    provider: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | null> {
    return this.select(
      'provider = ? and external_transaction_id = ?',
      [provider, externalTransactionId],
      '',
    );
  }

  async isReversed(
    referenceTransactionId: string,
    type: WagerTransactionType,
  ): Promise<boolean> {
    const rows = await queryRows(
      this.em,
      `select 1 from wager_transactions
       where reference_transaction_id = ? and type = ? and status = 'PROCESSED'
       limit 1`,
      [referenceTransactionId, type],
    );
    return rows.length > 0;
  }

  async insert(
    transaction: WagerTransaction,
    meta: InsertTransactionMeta,
  ): Promise<void> {
    await runStatement(
      this.em,
      `insert into wager_transactions
        (id, provider, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, type, amount_in_cents, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, response_snapshot, correlation_id,
         pending_attempts, pending_expires_at, pending_next_attempt_at, created_at, processed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::bigint, ?, ?, ?, ?, ?, ?::jsonb, ?, 0,
               ?::timestamptz, ?::timestamptz, ?::timestamptz, ?::timestamptz)`,
      [
        transaction.id,
        transaction.provider,
        transaction.externalTransactionId,
        meta.idempotencyKey,
        meta.payloadHash,
        transaction.walletId,
        transaction.playerId,
        transaction.roundId,
        transaction.type,
        transaction.amount.toCents().toString(),
        transaction.amount.currency,
        transaction.referenceExternalTransactionId,
        transaction.referenceTransactionId,
        transaction.status,
        transaction.failureCode,
        JSON.stringify(meta.responseSnapshot),
        meta.correlationId,
        meta.pending?.expiresAt.toISOString() ?? null,
        meta.pending?.nextAttemptAt.toISOString() ?? null,
        transaction.createdAt.toISOString(),
        transaction.processedAt?.toISOString() ?? null,
      ],
    );
  }

  async update(
    transaction: WagerTransaction,
    patch: TransactionUpdate = {},
  ): Promise<void> {
    await runStatement(
      this.em,
      `update wager_transactions
       set status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?::timestamptz,
           pending_attempts = coalesce(?, pending_attempts),
           pending_next_attempt_at = case
             when ?::timestamptz is not null then ?::timestamptz
             when ? <> 'PENDING_REFERENCE' then null
             else pending_next_attempt_at end
       where id = ?`,
      [
        transaction.status,
        transaction.failureCode,
        transaction.referenceTransactionId,
        transaction.processedAt?.toISOString() ?? null,
        patch.pendingAttempts ?? null,
        patch.pendingNextAttemptAt?.toISOString() ?? null,
        patch.pendingNextAttemptAt?.toISOString() ?? null,
        transaction.status,
        transaction.id,
      ],
    );
  }

  private async select(
    condition: string,
    params: unknown[],
    suffix: string,
  ): Promise<StoredWagerTransaction | null> {
    const [row] = await queryRows(
      this.em,
      `select ${COLUMNS} from wager_transactions where ${condition}${suffix}`,
      params,
    );
    return row ? this.toStored(row) : null;
  }

  private toStored(row: Row): StoredWagerTransaction {
    return {
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      responseSnapshot: row.response_snapshot ?? null,
      correlationId: row.correlation_id ?? null,
      pendingAttempts: Number(row.pending_attempts),
      pendingExpiresAt: parseTimestamp(row.pending_expires_at),
      transaction: WagerTransaction.rehydrate({
        id: row.id,
        provider: row.provider,
        externalTransactionId: row.external_transaction_id,
        playerId: row.player_id,
        roundId: row.round_id,
        type: row.type as WagerTransactionType,
        amount: Money.fromCents(BigInt(row.amount_in_cents), row.currency),
        walletId: row.wallet_id,
        referenceExternalTransactionId: row.reference_external_transaction_id,
        referenceTransactionId: row.reference_transaction_id,
        status: row.status as WagerTransactionStatus,
        failureCode: row.failure_code as FailureCode | null,
        createdAt: parseTimestamp(row.created_at) as Date,
        processedAt: parseTimestamp(row.processed_at),
      }),
    };
  }
}

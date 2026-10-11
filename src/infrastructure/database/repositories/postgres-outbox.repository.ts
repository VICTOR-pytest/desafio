import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ClaimedOutboxMessage,
  OutboxEvent,
  OutboxRepository,
  OutboxStore,
} from '../../../application/ports';
import {
  parseTimestamp,
  queryRows,
  runStatement,
  timestampColumn,
} from './sql';

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(event: OutboxEvent): Promise<void> {
    await runStatement(
      this.em,
      `insert into outbox_messages
        (id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, status,
         attempts, next_attempt_at, created_at)
       values (?, ?, ?, ?, ?::jsonb, ?, ?, 'PENDING', 0, ?::timestamptz, ?::timestamptz)`,
      [
        event.id,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.correlationId,
        event.causationId,
        event.occurredAt.toISOString(),
        event.occurredAt.toISOString(),
      ],
    );
  }
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly em: EntityManager) {}

  async claimBatch(options: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedOutboxMessage[]> {
    const lockedUntil = new Date(options.now.getTime() + options.leaseMs);

    const rows = await this.em.transactional((tem) =>
      queryRows(
        tem as EntityManager,
        `update outbox_messages set locked_until = ?::timestamptz, attempts = attempts + 1
         where id in (
           select id from outbox_messages
           where status = 'PENDING'
             and next_attempt_at <= ?::timestamptz
             and (locked_until is null or locked_until <= ?::timestamptz)
           order by created_at, id
           limit ?
           for update skip locked
         )
         returning id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, attempts,
                   ${timestampColumn('created_at')}`,
        [
          lockedUntil.toISOString(),
          options.now.toISOString(),
          options.now.toISOString(),
          options.limit,
        ],
      ),
    );

    return rows
      .map((row) => ({
        id: row.id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        correlationId: row.correlation_id ?? null,
        causationId: row.causation_id ?? null,
        attempts: Number(row.attempts),
        createdAt: parseTimestamp(row.created_at) as Date,
      }))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  async markPublished(id: string, now: Date): Promise<void> {
    await runStatement(
      this.em,
      `update outbox_messages
       set status = 'PUBLISHED', published_at = ?::timestamptz, locked_until = null, last_error = null
       where id = ?`,
      [now.toISOString(), id],
    );
  }

  async markFailed(
    id: string,
    failure: { error: string; nextAttemptAt: Date; giveUp: boolean },
  ): Promise<void> {
    await runStatement(
      this.em,
      `update outbox_messages
       set status = ?, next_attempt_at = ?::timestamptz, locked_until = null, last_error = ?
       where id = ?`,
      [
        failure.giveUp ? 'FAILED' : 'PENDING',
        failure.nextAttemptAt.toISOString(),
        failure.error,
        id,
      ],
    );
  }

  async oldestPendingAgeSeconds(now: Date): Promise<number> {
    const [row] = await queryRows(
      this.em,
      `select coalesce(extract(epoch from (?::timestamptz - min(created_at))), 0)::float8 as age
       from outbox_messages where status = 'PENDING'`,
      [now.toISOString()],
    );

    return Math.max(0, Number(row.age));
  }
}

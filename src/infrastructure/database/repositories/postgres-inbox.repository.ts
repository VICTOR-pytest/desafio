import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxRecord, InboxRepository } from '../../../application/ports';
import { queryRows, runStatement } from './sql';

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(record: InboxRecord): Promise<boolean> {
    const rows = await queryRows(
      this.em,
      `insert into inbox_messages (id, source, message_id, payload, received_at)
       values (?, ?, ?, ?::jsonb, ?::timestamptz)
       on conflict (source, message_id) do nothing
       returning id`,
      [
        record.id,
        record.source,
        record.messageId,
        JSON.stringify(record.payload),
        record.receivedAt.toISOString(),
      ],
    );
    return rows.length === 1;
  }

  async linkTransaction(
    source: string,
    messageId: string,
    transactionId: string,
  ): Promise<void> {
    await runStatement(
      this.em,
      `update inbox_messages
       set transaction_id = ?, processed_at = now()
       where source = ? and message_id = ? and transaction_id is null`,
      [transactionId, source, messageId],
    );
  }
}

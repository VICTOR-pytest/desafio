import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WagerTransactionEntity } from './wager-transaction.entity';

@Entity({ tableName: 'inbox_messages' })
@Unique({
  name: 'inbox_messages_source_message_id_unique',
  properties: ['source', 'messageId'],
})
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 32 })
  source!: string;

  @Property({ type: 'string', length: 255 })
  messageId!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @ManyToOne({
    entity: () => WagerTransactionEntity,
    nullable: true,
    deleteRule: 'restrict',
  })
  transaction?: WagerTransactionEntity;

  @Property({ type: 'datetime' })
  receivedAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date;
}

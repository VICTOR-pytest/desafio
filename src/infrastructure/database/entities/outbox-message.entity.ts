import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'outbox_messages_pending_idx',
  expression: `create index "outbox_messages_pending_idx" on "outbox_messages" ("next_attempt_at") where "status" = 'PENDING'`,
})
@Check({
  name: 'outbox_messages_status_valid',
  expression: `status in ('PENDING', 'PUBLISHED', 'FAILED')`,
})
@Check({
  name: 'outbox_messages_attempts_non_negative',
  expression: 'attempts >= 0',
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 32 })
  aggregateType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'string', length: 64 })
  eventType!: string;

  @Property({ type: 'string', length: 128, nullable: true })
  correlationId?: string;

  @Property({ type: 'string', length: 128, nullable: true })
  causationId?: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'string', length: 16, default: 'PENDING' })
  status!: string;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime' })
  nextAttemptAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  lockedUntil?: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date;

  @Property({ type: 'text', nullable: true })
  lastError?: string;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}

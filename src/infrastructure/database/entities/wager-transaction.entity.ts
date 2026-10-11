import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transactions_provider_external_id_unique',
  properties: ['provider', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_provider_idempotency_key_unique',
  properties: ['provider', 'idempotencyKey'],
})
@Index({
  name: 'wager_transactions_wallet_created_idx',
  properties: ['wallet', 'createdAt'],
})
@Index({
  name: 'wager_transactions_provider_reference_idx',
  properties: ['provider', 'referenceExternalTransactionId'],
})
@Index({
  name: 'wager_transactions_single_reversal_per_type_unique',
  expression: `create unique index "wager_transactions_single_reversal_per_type_unique" on "wager_transactions" ("reference_transaction_id", "type") where "status" = 'PROCESSED' and "type" in ('REFUND', 'ROLLBACK')`,
})
@Index({
  name: 'wager_transactions_pending_reference_idx',
  expression: `create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("pending_next_attempt_at") where "status" = 'PENDING_REFERENCE'`,
})
@Check({
  name: 'wager_transactions_type_valid',
  expression: `type in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')`,
})
@Check({
  name: 'wager_transactions_status_valid',
  expression: `status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')`,
})
@Check({
  name: 'wager_transactions_amount_valid',
  expression: `amount_in_cents > 0 or (type = 'OPENING' and amount_in_cents = 0)`,
})
@Check({
  name: 'wager_transactions_reference_required',
  expression: `(type in ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id is not null)`,
})
@Check({
  name: 'wager_transactions_failure_code_consistent',
  expression: `(status in ('REJECTED', 'FAILED')) = (failure_code is not null)`,
})
@Check({
  name: 'wager_transactions_processed_at_consistent',
  expression: `(status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)`,
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 64 })
  provider!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @ManyToOne({
    entity: () => WalletEntity,
    nullable: true,
    deleteRule: 'restrict',
  })
  wallet?: WalletEntity;

  @Property({ type: 'string', length: 255 })
  playerId!: string;

  @Property({ type: 'string', length: 128 })
  roundId!: string;

  @Property({ type: 'string', length: 16 })
  type!: string;

  @Property({ type: 'bigint' })
  amountInCents!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @ManyToOne({
    entity: () => WagerTransactionEntity,
    nullable: true,
    deleteRule: 'restrict',
  })
  referenceTransaction?: WagerTransactionEntity;

  @Property({ type: 'string', length: 24 })
  status!: string;

  @Property({ type: 'string', length: 64, nullable: true })
  failureCode?: string;

  @Property({ type: 'json', nullable: true })
  responseSnapshot?: Record<string, unknown>;

  @Property({ type: 'string', length: 128, nullable: true })
  correlationId?: string;

  @Property({ type: 'integer', default: 0 })
  pendingAttempts!: number;

  @Property({ type: 'datetime', nullable: true })
  pendingExpiresAt?: Date;

  @Property({ type: 'datetime', nullable: true })
  pendingNextAttemptAt?: Date;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date;
}

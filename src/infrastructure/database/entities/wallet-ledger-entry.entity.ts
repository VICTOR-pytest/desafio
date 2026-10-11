import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'wallet_ledger_entries_wallet_transaction_unique',
  properties: ['wallet', 'transaction'],
})
@Index({
  name: 'wallet_ledger_entries_wallet_sequence_idx',
  properties: ['wallet', 'sequence'],
})
@Check({
  name: 'wallet_ledger_entries_type_valid',
  expression: `entry_type in ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')`,
})
@Check({
  name: 'wallet_ledger_entries_direction_valid',
  expression: `direction in ('CREDIT', 'DEBIT')`,
})
@Check({
  name: 'wallet_ledger_entries_amount_valid',
  expression: `amount_in_cents > 0 or (entry_type = 'OPENING' and amount_in_cents = 0)`,
})
@Check({
  name: 'wallet_ledger_entries_balances_non_negative',
  expression: `balance_before_in_cents >= 0 and balance_after_in_cents >= 0`,
})
@Check({
  name: 'wallet_ledger_entries_balance_consistent',
  expression: `(direction = 'CREDIT' and balance_after_in_cents = balance_before_in_cents + amount_in_cents) or (direction = 'DEBIT' and balance_after_in_cents = balance_before_in_cents - amount_in_cents)`,
})
@Trigger({
  name: 'wallet_ledger_entries_immutable_rows',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: `raise exception 'wallet_ledger_entries é imutável' using errcode = '55000';`,
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne({ entity: () => WalletEntity, deleteRule: 'restrict' })
  wallet!: WalletEntity;

  @ManyToOne({ entity: () => WagerTransactionEntity, deleteRule: 'restrict' })
  transaction!: WagerTransactionEntity;

  @Property({ type: 'string', length: 16 })
  entryType!: string;

  @Property({ type: 'string', length: 6 })
  direction!: string;

  @Property({ type: 'bigint' })
  amountInCents!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'bigint' })
  balanceBeforeInCents!: string;

  @Property({ type: 'bigint' })
  balanceAfterInCents!: string;

  @Property({ type: 'bigint', autoincrement: true })
  sequence!: string;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}

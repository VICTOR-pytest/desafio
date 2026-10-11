import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'reconciliation_discrepancies' })
@Index({
  name: 'reconciliation_discrepancies_wallet_detected_idx',
  properties: ['wallet', 'detectedAt'],
})
@Check({
  name: 'reconciliation_discrepancies_source_valid',
  expression: `source in ('MANUAL', 'SCHEDULED')`,
})
@Check({
  name: 'reconciliation_discrepancies_difference_nonzero',
  expression: 'difference_in_cents <> 0',
})
export class ReconciliationDiscrepancyEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne({ entity: () => WalletEntity, deleteRule: 'restrict' })
  wallet!: WalletEntity;

  @Property({ type: 'bigint' })
  materializedBalanceInCents!: string;

  @Property({ type: 'bigint' })
  ledgerBalanceInCents!: string;

  @Property({ type: 'bigint' })
  differenceInCents!: string;

  @Property({ type: 'bigint' })
  walletVersion!: string;

  @Property({ type: 'string', length: 16 })
  source!: string;

  @Property({ type: 'datetime' })
  detectedAt!: Date;
}

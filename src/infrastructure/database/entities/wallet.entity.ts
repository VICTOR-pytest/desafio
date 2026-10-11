
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"] })
@Check({
  name: "wallets_balance_non_negative",
  expression: "balance_in_cents >= 0",
})
@Check({
  name: "wallets_version_positive",
  expression: "version >= 1",
})
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string" })
  playerId!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({ type: "bigint" })
  balanceInCents: string = "0";

  @Property({ type: "bigint", default: 1 })
  version: string = "1";

  @Property({ type: "datetime" })
  createdAt: Date = new Date();

  @Property({ type: "datetime", onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}

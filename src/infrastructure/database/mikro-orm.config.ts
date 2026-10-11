
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { InboxMessageEntity } from "./entities/inbox-message.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { ReconciliationDiscrepancyEntity } from "./entities/reconciliation-discrepancy.entity";
import { WalletEntity } from "./entities/wallet.entity";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { DatabaseSettings, readDatabaseSettings } from "../config/env";

export function buildMikroOrmConfig(settings: DatabaseSettings) {
  return defineConfig({
    host: settings.host,
    port: settings.port,
    dbName: settings.dbName,
    user: settings.user,
    password: settings.password,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
      ReconciliationDiscrepancyEntity,
    ],
    extensions: [Migrator],
    migrations: {
      path: "dist/infrastructure/database/migrations",
      pathTs: "src/infrastructure/database/migrations",
    },
  });
}

export default buildMikroOrmConfig(readDatabaseSettings());

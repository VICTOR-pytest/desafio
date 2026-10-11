import { Migration } from '@mikro-orm/migrations';

export class Migration20261010195457_conformance extends Migration {

  override name = 'Migration20261010195457_conformance';

  override up(): void | Promise<void> {
    this.addSql(`create table "reconciliation_discrepancies" ("id" uuid not null, "wallet_id" uuid not null, "materialized_balance_in_cents" bigint not null, "ledger_balance_in_cents" bigint not null, "difference_in_cents" bigint not null, "wallet_version" bigint not null, "source" varchar(16) not null, "detected_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "reconciliation_discrepancies_wallet_detected_idx" on "reconciliation_discrepancies" ("wallet_id", "detected_at");`);

    this.addSql(`alter table "outbox_messages" add "correlation_id" varchar(128) null, add "causation_id" varchar(128) null;`);

    this.addSql(`alter table "wallets" add "version" bigint not null default '1';`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);

    this.addSql(`drop index "wager_transactions_single_reversal_unique";`);
    this.addSql(`alter table "wager_transactions" add "response_snapshot" jsonb null, add "correlation_id" varchar(128) null, add "pending_attempts" int not null default 0, add "pending_expires_at" timestamptz null, add "pending_next_attempt_at" timestamptz null;`);
    this.addSql(`create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("pending_next_attempt_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "wager_transactions_single_reversal_per_type_unique" on "wager_transactions" ("reference_transaction_id", "type") where "status" = 'PROCESSED' and "type" in ('REFUND', 'ROLLBACK');`);

    this.addSql(`drop index "wallet_ledger_entries_wallet_created_idx";`);
    this.addSql(`alter table "wallet_ledger_entries" add "sequence" bigserial not null;`);
    this.addSql(`create index "wallet_ledger_entries_wallet_sequence_idx" on "wallet_ledger_entries" ("wallet_id", "sequence");`);

    this.addSql(`alter table "reconciliation_discrepancies" add constraint "reconciliation_discrepancies_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "reconciliation_discrepancies" add constraint "reconciliation_discrepancies_difference_nonzero" check (difference_in_cents <> 0);`);
    this.addSql(`alter table "reconciliation_discrepancies" add constraint "reconciliation_discrepancies_source_valid" check (source in ('MANUAL', 'SCHEDULED'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "reconciliation_discrepancies" cascade;`);

    this.addSql(`alter table "outbox_messages" drop column "correlation_id", drop column "causation_id";`);

    this.addSql(`drop index "wager_transactions_pending_reference_idx";`);
    this.addSql(`drop index "wager_transactions_single_reversal_per_type_unique";`);
    this.addSql(`alter table "wager_transactions" drop column "response_snapshot", drop column "correlation_id", drop column "pending_attempts", drop column "pending_expires_at", drop column "pending_next_attempt_at";`);
    this.addSql(`create unique index "wager_transactions_single_reversal_unique" on "wager_transactions" ("reference_transaction_id") where "status" = 'PROCESSED' and "type" in ('REFUND', 'ROLLBACK');`);

    this.addSql(`drop index "wallet_ledger_entries_wallet_sequence_idx";`);
    this.addSql(`alter table "wallet_ledger_entries" drop column "sequence";`);
    this.addSql(`create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);

    this.addSql(`alter table "wallets" drop constraint "wallets_version_positive";`);
    this.addSql(`alter table "wallets" drop column "version";`);
  }

}

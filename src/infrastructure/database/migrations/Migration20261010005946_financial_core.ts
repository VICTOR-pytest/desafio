import { Migration } from '@mikro-orm/migrations';

export class Migration20261010005946_financial_core extends Migration {

  override name = 'Migration20261010005946_financial_core';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_type" varchar(32) not null, "aggregate_id" uuid not null, "event_type" varchar(64) not null, "payload" jsonb not null, "status" varchar(16) not null default 'PENDING', "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "locked_until" timestamptz null, "published_at" timestamptz null, "last_error" text null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_pending_idx" on "outbox_messages" ("next_attempt_at") where "status" = 'PENDING';`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider" varchar(64) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid null, "player_id" varchar(255) not null, "round_id" varchar(128) not null, "type" varchar(16) not null, "amount_in_cents" bigint not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "status" varchar(24) not null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "wager_transactions_single_reversal_unique" on "wager_transactions" ("reference_transaction_id") where "status" = 'PROCESSED' and "type" in ('REFUND', 'ROLLBACK');`);
    this.addSql(`create index "wager_transactions_provider_reference_idx" on "wager_transactions" ("provider", "reference_external_transaction_id");`);
    this.addSql(`create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_idempotency_key_unique" unique ("provider", "idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_id_unique" unique ("provider", "external_transaction_id");`);

    this.addSql(`create table "inbox_messages" ("id" uuid not null, "source" varchar(32) not null, "message_id" varchar(255) not null, "payload" jsonb not null, "transaction_id" uuid null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_source_message_id_unique" unique ("source", "message_id");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "entry_type" varchar(16) not null, "direction" varchar(6) not null, "amount_in_cents" bigint not null, "currency" varchar(3) not null, "balance_before_in_cents" bigint not null, "balance_after_in_cents" bigint not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance_in_cents >= 0);`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_non_negative" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_status_valid" check (status in ('PENDING', 'PUBLISHED', 'FAILED'));`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_processed_at_consistent" check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_consistent" check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_required" check ((type in ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id is not null));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_valid" check (amount_in_cents > 0 or (type = 'OPENING' and amount_in_cents = 0));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_valid" check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_type_valid" check (type in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_consistent" check ((direction = 'CREDIT' and balance_after_in_cents = balance_before_in_cents + amount_in_cents) or (direction = 'DEBIT' and balance_after_in_cents = balance_before_in_cents - amount_in_cents));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balances_non_negative" check (balance_before_in_cents >= 0 and balance_after_in_cents >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_valid" check (amount_in_cents > 0 or (entry_type = 'OPENING' and amount_in_cents = 0));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_valid" check (direction in ('CREDIT', 'DEBIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_type_valid" check (entry_type in ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK'));`);

    this.addSql(`create or replace function "wallet_ledger_entries_wallet_ledger_entries_immutable_rows_fn"() returns trigger as $$ begin raise exception 'wallet_ledger_entries é imutável' using errcode = '55000'; end; $$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entries_immutable_rows" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wallet_ledger_entries_immutable_rows_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);
    this.addSql(`alter table "inbox_messages" drop constraint "inbox_messages_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_foreign";`);

    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_entries_immutable_rows_fn"();`);

    this.addSql(`alter table "wallets" drop constraint "wallets_balance_non_negative";`);
  }

}

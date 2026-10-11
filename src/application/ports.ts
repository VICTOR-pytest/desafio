import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { MoneyProps } from '../domain/money/money';
import { FailureCode } from '../domain/wager/failure-code';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';

export interface WalletSummary {
  walletId: string;
  balance: MoneyProps;
  version: number;
}

export interface ResponseSnapshot {
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  wallet: WalletSummary | null;
}

export interface PendingReferenceTiming {
  expiresAt: Date;
  nextAttemptAt: Date;
}

export interface InsertTransactionMeta {
  idempotencyKey: string;
  payloadHash: string;
  responseSnapshot: ResponseSnapshot;
  correlationId: string | null;
  pending: PendingReferenceTiming | null;
}

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  idempotencyKey: string;
  payloadHash: string;
  responseSnapshot: ResponseSnapshot | null;
  correlationId: string | null;
  pendingAttempts: number;
  pendingExpiresAt: Date | null;
}

export interface TransactionUpdate {
  pendingAttempts?: number;
  pendingNextAttemptAt?: Date;
}

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: Date;
}

export interface InboxRecord {
  id: string;
  source: string;
  messageId: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
}

export interface LedgerPageItem {
  sequence: string;
  entryId: string;
  transactionId: string;
  type: string;
  direction: string;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  materializedCents: bigint;
  ledgerCents: bigint;
  walletVersion: number;
}

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  lockById(walletId: string): Promise<Wallet | null>;
  lockByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<StoredWagerTransaction | null>;
  lockById(id: string): Promise<StoredWagerTransaction | null>;
  findByIdempotencyKey(
    provider: string,
    idempotencyKey: string,
  ): Promise<StoredWagerTransaction | null>;
  findByExternalId(
    provider: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | null>;
  isReversed(
    referenceTransactionId: string,
    type: WagerTransactionType,
  ): Promise<boolean>;
  insert(
    transaction: WagerTransaction,
    meta: InsertTransactionMeta,
  ): Promise<void>;
  update(
    transaction: WagerTransaction,
    patch?: TransactionUpdate,
  ): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(
    walletId: string,
    afterSequence: string | null,
    limit: number,
  ): Promise<LedgerPageItem[]>;
}

export interface OutboxRepository {
  insert(event: OutboxEvent): Promise<void>;
}

export interface InboxRepository {
  register(record: InboxRecord): Promise<boolean>;
  linkTransaction(
    source: string,
    messageId: string,
    transactionId: string,
  ): Promise<void>;
}

export interface ReconciliationRepository {
  snapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
  recordDiscrepancy(
    snapshot: ReconciliationSnapshot,
    source: 'MANUAL' | 'SCHEDULED',
    now: Date,
  ): Promise<string>;
}

export interface TransactionalContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
  reconciliation: ReconciliationRepository;
}

export interface UnitOfWork {
  run<T>(work: (context: TransactionalContext) => Promise<T>): Promise<T>;
}

export interface ClaimedOutboxMessage {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  causationId: string | null;
  attempts: number;
  createdAt: Date;
}

export interface OutboxStore {
  claimBatch(options: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedOutboxMessage[]>;
  markPublished(id: string, now: Date): Promise<void>;
  markFailed(
    id: string,
    failure: { error: string; nextAttemptAt: Date; giveUp: boolean },
  ): Promise<void>;
  oldestPendingAgeSeconds(now: Date): Promise<number>;
}

export interface EventPublisher {
  publish(message: ClaimedOutboxMessage): Promise<void>;
}

export interface ClaimedPendingReference {
  transactionId: string;
  walletId: string;
}

export interface PendingReferenceStore {
  claimDue(options: {
    limit: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedPendingReference[]>;
}

export interface ReconciliationStore {
  listWalletIds(afterId: string | null, limit: number): Promise<string[]>;
}

export type Labels = Record<string, string>;

export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface Telemetry {
  metrics: Metrics;
  logger: Logger;
}

export const NOOP_TELEMETRY: Telemetry = {
  metrics: { increment: () => undefined, observe: () => undefined },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
};

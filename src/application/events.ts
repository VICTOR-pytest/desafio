import { randomUUID } from 'node:crypto';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { ClaimedOutboxMessage, OutboxEvent } from './ports';

export const EventTypes = {
  TransactionProcessed: 'WagerTransactionProcessed',
  TransactionRejected: 'WagerTransactionRejected',
  TransactionPendingReference: 'WagerTransactionPendingReference',
  WalletBalanceChanged: 'WalletBalanceChanged',
} as const;

export const EVENT_SCHEMA_VERSION = 1;

export interface IntegrationEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

export interface EventContext {
  correlationId: string | null;
  causationId: string | null;
  now: Date;
}

function describeTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    provider: transaction.provider,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    type: transaction.type,
    amount: transaction.amount.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  };
}

export function transactionEvent(
  transaction: WagerTransaction,
  context: EventContext,
): OutboxEvent {
  const eventType =
    transaction.status === WagerTransactionStatus.PROCESSED
      ? EventTypes.TransactionProcessed
      : transaction.status === WagerTransactionStatus.REJECTED
        ? EventTypes.TransactionRejected
        : EventTypes.TransactionPendingReference;

  return {
    id: randomUUID(),
    aggregateType: 'WagerTransaction',
    aggregateId: transaction.id,
    eventType,
    payload: describeTransaction(transaction),
    correlationId: context.correlationId,
    causationId: context.causationId,
    occurredAt: context.now,
  };
}

export function balanceChangedEvent(
  wallet: Wallet,
  entry: WalletLedgerEntry,
  context: EventContext,
): OutboxEvent {
  return {
    id: randomUUID(),
    aggregateType: 'Wallet',
    aggregateId: wallet.id,
    eventType: EventTypes.WalletBalanceChanged,
    payload: {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      transactionId: entry.transactionId,
      entryType: entry.type,
      direction: entry.direction,
      amount: entry.amount.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    },
    correlationId: context.correlationId,
    causationId: context.causationId,
    occurredAt: context.now,
  };
}

export function toIntegrationEvent(
  message: ClaimedOutboxMessage,
): IntegrationEvent {
  const event: IntegrationEvent = {
    eventId: message.id,
    eventType: message.eventType,
    aggregateId: message.aggregateId,
    correlationId: message.correlationId ?? message.aggregateId,
    occurredAt: message.createdAt.toISOString(),
    version: EVENT_SCHEMA_VERSION,
    data: message.payload,
  };

  if (message.causationId) {
    event.causationId = message.causationId;
  }

  return event;
}

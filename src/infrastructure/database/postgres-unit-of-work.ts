import {
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { RetryableError } from '../../application/errors';
import { TransactionalContext, UnitOfWork } from '../../application/ports';
import { PostgresInboxRepository } from './repositories/postgres-inbox.repository';
import { PostgresLedgerRepository } from './repositories/postgres-ledger.repository';
import { PostgresOutboxRepository } from './repositories/postgres-outbox.repository';
import { PostgresReconciliationRepository } from './repositories/postgres-reconciliation.repository';
import { PostgresWagerTransactionRepository } from './repositories/postgres-wager-transaction.repository';
import { PostgresWalletRepository } from './repositories/postgres-wallet.repository';

export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new RetryableError(
      'Conflito de unicidade durante o processamento',
      (error as { constraint?: string }).constraint,
    );
  }

  if (
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return new RetryableError('Conflito transitório de concorrência');
  }

  return error;
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(protected readonly em: EntityManager) {}

  async run<T>(
    work: (context: TransactionalContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.transactional((transactionalEm) =>
        work(this.createContext(transactionalEm as EntityManager)),
      );
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  protected createContext(em: EntityManager): TransactionalContext {
    return {
      wallets: new PostgresWalletRepository(em),
      transactions: new PostgresWagerTransactionRepository(em),
      ledger: new PostgresLedgerRepository(em),
      outbox: new PostgresOutboxRepository(em),
      inbox: new PostgresInboxRepository(em),
      reconciliation: new PostgresReconciliationRepository(em),
    };
  }
}

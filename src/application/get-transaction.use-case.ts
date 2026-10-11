import { MoneyProps } from '../domain/money/money';
import { TransactionNotFoundError } from './errors';
import { StoredWagerTransaction, UnitOfWork } from './ports';
import { isUuid } from './uuid';

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string | null;
  roundId: string;
  type: string;
  amount: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  createdAt: string;
  processedAt: string | null;
}

function toView({ transaction }: StoredWagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.provider,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    type: transaction.type,
    amount: transaction.amount.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export class GetTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  byId(transactionId: string): Promise<TransactionView> {
    if (!isUuid(transactionId)) {
      return Promise.reject(new TransactionNotFoundError());
    }

    return this.unitOfWork.run(async (context) => {
      const stored = await context.transactions.findById(transactionId);

      if (!stored) {
        throw new TransactionNotFoundError();
      }

      return toView(stored);
    });
  }

  byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.unitOfWork.run(async (context) => {
      const stored = await context.transactions.findByExternalId(
        providerId,
        externalTransactionId,
      );

      if (!stored) {
        throw new TransactionNotFoundError();
      }

      return toView(stored);
    });
  }
}

import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain-error';
import {
  LedgerDirection,
  LedgerEntryType,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry';
import { FailureCode } from '../wager/failure-code';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from '../wager/wager-transaction';
import { Wallet } from '../wallet/wallet';

export interface ReferenceContext {
  transaction: WagerTransaction | null;
  alreadyReversed: boolean;
}

const REFUNDABLE_TYPES = new Set([WagerTransactionType.BET]);

const ROLLBACK_DIRECTION = new Map<WagerTransactionType, LedgerDirection>([
  [WagerTransactionType.BET, LedgerDirection.CREDIT],
  [WagerTransactionType.WIN, LedgerDirection.DEBIT],
  [WagerTransactionType.REFUND, LedgerDirection.DEBIT],
]);

export class WagerProcessor {
  constructor(private readonly newId: () => string = randomUUID) {}

  process(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: ReferenceContext | null = null,
  ): WalletLedgerEntry | null {
    if (transaction.isTerminal()) {
      throw new DomainError(
        'INVALID_TRANSITION',
        `Transação em estado terminal (${transaction.status}) não pode ser reprocessada`,
      );
    }

    transaction.bindWallet(wallet.id);

    if (transaction.amount.currency !== wallet.currency) {
      return this.reject(transaction, FailureCode.CURRENCY_MISMATCH);
    }

    if (transaction.playerId !== wallet.playerId) {
      return this.reject(transaction, FailureCode.PLAYER_MISMATCH);
    }

    switch (transaction.type) {
      case WagerTransactionType.OPENING:
        return this.open(transaction, wallet);

      case WagerTransactionType.BET:
        if (wallet.balance.isLessThan(transaction.amount)) {
          return this.reject(transaction, FailureCode.INSUFFICIENT_FUNDS);
        }
        return this.move(
          transaction,
          wallet,
          LedgerEntryType.BET,
          LedgerDirection.DEBIT,
        );

      case WagerTransactionType.WIN:
        return this.move(
          transaction,
          wallet,
          LedgerEntryType.WIN,
          LedgerDirection.CREDIT,
        );

      case WagerTransactionType.LOSS:
        // A aposta já foi debitada no evento BET.
        // LOSS apenas registra o resultado.
        transaction.markProcessed();
        return null;

      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK:
        return this.reverse(transaction, wallet, reference);

      default: {
        const unknownType: never = transaction.type;
        throw new DomainError(
          'INVALID_TRANSACTION_TYPE',
          `Tipo de transação não suportado: ${String(unknownType)}`,
        );
      }
    }
  }

  private open(transaction: WagerTransaction, wallet: Wallet): WalletLedgerEntry {
    if (!wallet.balance.isZero()) {
      throw new DomainError(
        'WALLET_ALREADY_OPENED',
        'OPENING só pode ser aplicado a uma carteira sem saldo',
      );
    }

    return this.move(
      transaction,
      wallet,
      LedgerEntryType.OPENING,
      LedgerDirection.CREDIT,
    );
  }

  private reverse(
    transaction: WagerTransaction,
    wallet: Wallet,
    context: ReferenceContext | null,
  ): WalletLedgerEntry | null {
    const referenced = context?.transaction ?? null;

    if (!referenced) {
      transaction.markPendingReference();
      return null;
    }

    const mismatch = this.findReferenceMismatch(transaction, wallet, referenced);

    if (mismatch) {
      return this.reject(transaction, mismatch);
    }

    transaction.bindReference(referenced.id);

    if (
      referenced.status === WagerTransactionStatus.PENDING ||
      referenced.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      transaction.markPendingReference();
      return null;
    }

    if (referenced.status !== WagerTransactionStatus.PROCESSED) {
      return this.reject(transaction, FailureCode.REFERENCE_NOT_PROCESSED);
    }

    const isRefund = transaction.type === WagerTransactionType.REFUND;
    const direction = isRefund
      ? LedgerDirection.CREDIT
      : ROLLBACK_DIRECTION.get(referenced.type);
    const allowed = isRefund
      ? REFUNDABLE_TYPES.has(referenced.type)
      : ROLLBACK_DIRECTION.has(referenced.type);

    if (!allowed || !direction) {
      return this.reject(transaction, FailureCode.REFERENCE_TYPE_NOT_ALLOWED);
    }

    if (context?.alreadyReversed) {
      return this.reject(transaction, FailureCode.ALREADY_REVERSED);
    }

    if (!referenced.amount.equals(transaction.amount)) {
      return this.reject(transaction, FailureCode.AMOUNT_MISMATCH);
    }

    if (
      direction === LedgerDirection.DEBIT &&
      wallet.balance.isLessThan(transaction.amount)
    ) {
      return this.reject(transaction, FailureCode.ROLLBACK_NEGATIVE_BALANCE);
    }

    return this.move(
      transaction,
      wallet,
      isRefund ? LedgerEntryType.REFUND : LedgerEntryType.ROLLBACK,
      direction,
    );
  }

  private findReferenceMismatch(
    transaction: WagerTransaction,
    wallet: Wallet,
    referenced: WagerTransaction,
  ): FailureCode | null {
    if (referenced.provider !== transaction.provider) {
      return FailureCode.PROVIDER_MISMATCH;
    }

    if (referenced.playerId !== transaction.playerId) {
      return FailureCode.PLAYER_MISMATCH;
    }

    if (referenced.amount.currency !== transaction.amount.currency) {
      return FailureCode.CURRENCY_MISMATCH;
    }

    if (referenced.walletId !== wallet.id) {
      return FailureCode.WALLET_MISMATCH;
    }

    if (referenced.roundId !== transaction.roundId) {
      return FailureCode.ROUND_MISMATCH;
    }

    return null;
  }

  private move(
    transaction: WagerTransaction,
    wallet: Wallet,
    type: LedgerEntryType,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    const balanceBefore = wallet.balance;

    if (type === LedgerEntryType.OPENING) {
      wallet.openWith(transaction.amount);
    } else if (direction === LedgerDirection.CREDIT) {
      wallet.credit(transaction.amount);
    } else {
      wallet.debit(transaction.amount);
    }

    const entry = WalletLedgerEntry.create({
      id: this.newId(),
      walletId: wallet.id,
      transactionId: transaction.id,
      type,
      direction,
      amount: transaction.amount,
      balanceBefore,
      balanceAfter: wallet.balance,
    });

    transaction.markProcessed();
    return entry;
  }

  private reject(
    transaction: WagerTransaction,
    failureCode: FailureCode,
  ): null {
    transaction.markRejected(failureCode);
    return null;
  }
}

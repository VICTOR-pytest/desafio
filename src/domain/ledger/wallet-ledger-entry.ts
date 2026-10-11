import { DomainError } from '../domain-error';
import { Money } from '../money/money';

export enum LedgerEntryType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum LedgerDirection {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly type: LedgerEntryType,
    public readonly direction: LedgerDirection,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return WalletLedgerEntry.build(props);
  }

  static rehydrate(
    props: WalletLedgerEntryProps & { createdAt: Date },
  ): WalletLedgerEntry {
    return WalletLedgerEntry.build(props);
  }

  private static build(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const {
      id,
      walletId,
      transactionId,
      type,
      direction,
      amount,
      balanceBefore,
      balanceAfter,
    } = props;

    if (!id?.trim()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'O ID do lançamento é obrigatório');
    }

    if (!walletId?.trim()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'O ID da carteira é obrigatório');
    }

    if (!transactionId?.trim()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'O ID da transação é obrigatório');
    }

    const isOpening = type === LedgerEntryType.OPENING;

    if (amount.isNegative() || (!isOpening && amount.isZero())) {
      throw new DomainError(
        'INVALID_LEDGER_ENTRY',
        'O valor do lançamento deve ser positivo',
      );
    }

    if (
      balanceBefore.currency !== amount.currency ||
      balanceAfter.currency !== amount.currency
    ) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'Os valores do lançamento devem usar a mesma moeda',
      );
    }

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new DomainError('NEGATIVE_BALANCE', 'O saldo não pode ser negativo');
    }

    if (isOpening && (direction !== LedgerDirection.CREDIT || !balanceBefore.isZero())) {
      throw new DomainError(
        'INVALID_LEDGER_ENTRY',
        'OPENING deve ser um crédito sobre saldo zero',
      );
    }

    const expectedBalance =
      direction === LedgerDirection.CREDIT
        ? balanceBefore.add(amount)
        : balanceBefore.subtract(amount);

    if (!expectedBalance.equals(balanceAfter)) {
      throw new DomainError(
        'INVALID_LEDGER_ENTRY',
        'O saldo posterior é incompatível com o lançamento',
      );
    }

    return new WalletLedgerEntry(
      id,
      walletId,
      transactionId,
      type,
      direction,
      amount,
      balanceBefore,
      balanceAfter,
      props.createdAt ?? new Date(),
    );
  }

  signedAmountInCents(): bigint {
    const cents = this.amount.toCents();
    return this.direction === LedgerDirection.CREDIT ? cents : -cents;
  }
}

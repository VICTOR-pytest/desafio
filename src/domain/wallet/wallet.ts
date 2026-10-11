import { DomainError } from '../domain-error';
import { Money } from '../money/money';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
}

export interface WalletSnapshot extends WalletProps {
  balance: Money;
  version: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private currentBalance: Money,
    private currentVersion: number,
  ) {}

  static create(props: WalletProps): Wallet {
    Wallet.assertIdentity(props);
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      Money.zero(props.currency),
      1,
    );
  }

  static rehydrate(snapshot: WalletSnapshot): Wallet {
    Wallet.assertIdentity(snapshot);

    if (snapshot.balance.currency !== snapshot.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'A moeda do saldo é diferente da carteira',
      );
    }

    if (snapshot.balance.isNegative()) {
      throw new DomainError('NEGATIVE_BALANCE', 'O saldo não pode ser negativo');
    }

    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
      throw new DomainError(
        'INVALID_WALLET',
        'A versão da carteira deve ser um inteiro maior ou igual a 1',
      );
    }

    return new Wallet(
      snapshot.id,
      snapshot.playerId,
      snapshot.currency,
      snapshot.balance,
      snapshot.version,
    );
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  openWith(initialBalance: Money): void {
    this.assertSameCurrency(initialBalance);

    if (
      initialBalance.isNegative() ||
      !this.currentBalance.isZero() ||
      this.currentVersion !== 1
    ) {
      throw new DomainError(
        'WALLET_ALREADY_OPENED',
        'OPENING só pode ser aplicado a uma carteira nova e sem saldo',
      );
    }

    this.currentBalance = initialBalance;
  }

  credit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (amount.isNegative()) {
      throw new DomainError(
        'INVALID_AMOUNT',
        'O crédito não pode ser negativo',
      );
    }

    if (amount.isZero()) {
      return;
    }

    this.currentBalance = this.currentBalance.add(amount);
    this.currentVersion += 1;
  }

  debit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (!amount.isPositive()) {
      throw new DomainError(
        'INVALID_AMOUNT',
        'O débito deve ser maior que zero',
      );
    }

    if (this.currentBalance.isLessThan(amount)) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Saldo insuficiente');
    }

    this.currentBalance = this.currentBalance.subtract(amount);
    this.currentVersion += 1;
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'A moeda da operação é diferente da carteira',
      );
    }
  }

  private static assertIdentity(props: WalletProps): void {
    if (!props.id?.trim()) {
      throw new DomainError('INVALID_WALLET', 'O ID da carteira é obrigatório');
    }

    if (!props.playerId?.trim()) {
      throw new DomainError('INVALID_WALLET', 'O ID do jogador é obrigatório');
    }

    Money.zero(props.currency);
  }
}

import { DomainError } from '../domain-error';

const MAX_CENTS = 9_223_372_036_854_775_807n;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    Money.assertCurrency(currency);

    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new DomainError('INVALID_AMOUNT', 'Quantia monetária inválida');
    }

    const [units, decimals] = amount.split('.');

    return Money.fromCents(BigInt(units) * 100n + BigInt(decimals), currency);
  }

  static fromCents(cents: bigint, currency: string): Money {
    Money.assertCurrency(currency);

    if (typeof cents !== 'bigint') {
      throw new DomainError('INVALID_AMOUNT', 'Quantia monetária inválida');
    }

    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new DomainError(
        'AMOUNT_OUT_OF_RANGE',
        'Quantia monetária fora do intervalo suportado',
      );
    }

    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.fromCents(-this.cents, this.currency);
  }

  toCents(): bigint {
    return this.cents;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);

    if (this.cents === other.cents) {
      return 0;
    }

    return this.cents < other.cents ? -1 : 1;
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  equals(other: Money): boolean {
    return this.compareTo(other) === 0;
  }

  toJSON(): MoneyProps {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const units = absolute / 100n;
    const decimals = (absolute % 100n).toString().padStart(2, '0');
    const sign = this.cents < 0n ? '-' : '';

    return {
      amount: `${sign}${units}.${decimals}`,
      currency: this.currency,
    };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'Não é possível operar com moedas diferentes',
      );
    }
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new DomainError('INVALID_CURRENCY', 'Código de moeda inválido');
    }
  }
}

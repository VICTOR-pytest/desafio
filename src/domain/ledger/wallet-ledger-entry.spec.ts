import { Money } from '../money/money';
import {
  LedgerDirection,
  LedgerEntryType,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const validDebit = () => ({
  id: 'ledger-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  type: LedgerEntryType.BET,
  direction: LedgerDirection.DEBIT,
  amount: brl('10.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('90.00'),
});

describe('WalletLedgerEntry', () => {
  it('cria um lançamento de débito válido', () => {
    const entry = WalletLedgerEntry.create(validDebit());

    expect(entry.amount.toCents()).toBe(1000n);
    expect(entry.direction).toBe(LedgerDirection.DEBIT);
    expect(entry.signedAmountInCents()).toBe(-1000n);
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('cria um lançamento de crédito válido', () => {
    const entry = WalletLedgerEntry.create({
      ...validDebit(),
      type: LedgerEntryType.WIN,
      direction: LedgerDirection.CREDIT,
      balanceAfter: brl('110.00'),
    });

    expect(entry.signedAmountInCents()).toBe(1000n);
  });

  it('reidrata preservando a data original', () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');

    expect(
      WalletLedgerEntry.rehydrate({ ...validDebit(), createdAt }).createdAt,
    ).toBe(createdAt);
  });

  it('aceita OPENING com valor zero ou positivo sobre saldo zero', () => {
    const opening = (amount: string) =>
      WalletLedgerEntry.create({
        ...validDebit(),
        type: LedgerEntryType.OPENING,
        direction: LedgerDirection.CREDIT,
        amount: brl(amount),
        balanceBefore: brl('0.00'),
        balanceAfter: brl(amount),
      });

    expect(opening('0.00').amount.isZero()).toBe(true);
    expect(opening('100.00').balanceAfter.toCents()).toBe(10000n);
  });

  it('rejeita OPENING como débito ou sobre saldo existente', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        type: LedgerEntryType.OPENING,
      }),
    ).toThrow('OPENING deve ser um crédito sobre saldo zero');
  });

  it('rejeita valor zero fora de OPENING', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        amount: brl('0.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow('O valor do lançamento deve ser positivo');
  });

  it('rejeita valor negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        amount: brl('10.00').negate(),
      }),
    ).toThrow('O valor do lançamento deve ser positivo');
  });

  it('rejeita identificadores vazios', () => {
    expect(() => WalletLedgerEntry.create({ ...validDebit(), id: '' })).toThrow();
    expect(() =>
      WalletLedgerEntry.create({ ...validDebit(), walletId: ' ' }),
    ).toThrow();
    expect(() =>
      WalletLedgerEntry.create({ ...validDebit(), transactionId: '' }),
    ).toThrow();
  });

  it('rejeita moedas divergentes entre valores', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceBefore: Money.from({ amount: '100.00', currency: 'USD' }),
      }),
    ).toThrow('mesma moeda');
  });

  it('rejeita saldos negativos', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow('saldo não pode ser negativo');
  });

  it('rejeita saldo posterior incompatível com a direção', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...validDebit(), balanceAfter: brl('110.00') }),
    ).toThrow('saldo posterior é incompatível');
  });
});

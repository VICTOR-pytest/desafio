import { Money } from '../money/money';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const identity = { id: 'wallet-1', playerId: 'player-1', currency: 'BRL' };

describe('Wallet', () => {
  it('começa com saldo zero', () => {
    expect(Wallet.create(identity).balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  it('reidrata com identidade e saldo', () => {
    const wallet = Wallet.rehydrate({ ...identity, version: 1, balance: brl('42.10') });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('42.10');
  });

  it('rejeita reidratação com saldo negativo ou moeda divergente', () => {
    expect(() =>
      Wallet.rehydrate({ ...identity, version: 1, balance: brl('1.00').negate() }),
    ).toThrow('saldo não pode ser negativo');
    expect(() =>
      Wallet.rehydrate({
        ...identity,
        version: 1,
        balance: Money.from({ amount: '1.00', currency: 'USD' }),
      }),
    ).toThrow('moeda do saldo');
  });

  it('rejeita identidade inválida', () => {
    expect(() => Wallet.create({ ...identity, id: ' ' })).toThrow();
    expect(() => Wallet.create({ ...identity, playerId: '' })).toThrow();
    expect(() => Wallet.create({ ...identity, currency: 'real' })).toThrow();
  });

  it('credita e debita', () => {
    const wallet = Wallet.create(identity);

    wallet.credit(brl('100.00'));
    wallet.debit(brl('30.00'));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
  });

  it('rejeita débito acima do saldo sem alterar o saldo', () => {
    const wallet = Wallet.rehydrate({ ...identity, version: 1, balance: brl('50.00') });

    expect(() => wallet.debit(brl('60.00'))).toThrow('Saldo insuficiente');
    expect(wallet.balance.toJSON().amount).toBe('50.00');
  });

  it('permite debitar exatamente o saldo', () => {
    const wallet = Wallet.rehydrate({ ...identity, version: 1, balance: brl('50.00') });

    wallet.debit(brl('50.00'));

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejeita crédito negativo e débito não positivo', () => {
    const wallet = Wallet.rehydrate({ ...identity, version: 1, balance: brl('50.00') });

    expect(() => wallet.credit(brl('1.00').negate())).toThrow();
    expect(() => wallet.debit(brl('0.00'))).toThrow('maior que zero');
  });

  it('rejeita operações com moeda diferente', () => {
    const wallet = Wallet.create(identity);
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.credit(usd)).toThrow('moeda da operação');
    expect(() => wallet.debit(usd)).toThrow('moeda da operação');
  });

  describe('versão', () => {
    const balance = (amount: string) => Money.from({ amount, currency: 'BRL' });

    it('começa em 1 e preserva a versão ao reidratar', () => {
      expect(Wallet.create(identity).version).toBe(1);
      expect(
        Wallet.rehydrate({ ...identity, version: 7, balance: balance('1.00') })
          .version,
      ).toBe(7);
    });

    it('aumenta uma unidade a cada alteração real do saldo', () => {
      const wallet = Wallet.create(identity);

      wallet.credit(balance('10.00'));
      wallet.debit(balance('3.00'));

      expect(wallet.version).toBe(3);
    });

    it('não muda com crédito zero nem com débito rejeitado', () => {
      const wallet = Wallet.rehydrate({
        ...identity,
        version: 4,
        balance: balance('5.00'),
      });

      wallet.credit(balance('0.00'));
      expect(() => wallet.debit(balance('9.00'))).toThrow('Saldo insuficiente');
      expect(() => wallet.credit(balance('1.00').negate())).toThrow();

      expect(wallet.version).toBe(4);
      expect(wallet.balance.toJSON().amount).toBe('5.00');
    });

    it('openWith define o saldo inicial sem alterar a versão', () => {
      const wallet = Wallet.create(identity);

      wallet.openWith(balance('100.00'));

      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('openWith só vale para carteira nova, sem saldo e na moeda correta', () => {
      const used = Wallet.create(identity);
      used.credit(balance('1.00'));

      expect(() => used.openWith(balance('1.00'))).toThrow('carteira nova');
      expect(() =>
        Wallet.create(identity).openWith(balance('1.00').negate()),
      ).toThrow('carteira nova');
      expect(() =>
        Wallet.create(identity).openWith(
          Money.from({ amount: '1.00', currency: 'USD' }),
        ),
      ).toThrow('moeda da operação');
    });

    it.each([0, -1, 1.5, Number.NaN])('rejeita versão inválida (%p)', (version) => {
      expect(() =>
        Wallet.rehydrate({ ...identity, version, balance: balance('1.00') }),
      ).toThrow('versão da carteira');
    });
  });
});

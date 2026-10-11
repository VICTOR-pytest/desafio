import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('cria um valor monetário', () => {
    expect(brl('50.75').toJSON()).toEqual({ amount: '50.75', currency: 'BRL' });
  });

  it('soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('10.10').add(brl('0.20')).toJSON().amount).toBe('10.30');
  });

  it('subtrai valores corretamente', () => {
    expect(brl('10.00').subtract(brl('3.50')).toJSON().amount).toBe('6.50');
  });

  it('permite resultado negativo apenas em operações internas', () => {
    const result = brl('1.00').subtract(brl('2.50'));

    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-1.50');
  });

  it('nega valores e preserva a moeda', () => {
    expect(brl('5.00').negate().toJSON()).toEqual({
      amount: '-5.00',
      currency: 'BRL',
    });
    expect(brl('0.00').negate().isZero()).toBe(true);
  });

  it.each([
    '10.5',
    '10',
    '10.505',
    '-10.00',
    '+10.00',
    '1e3',
    '1.0e2',
    '0x10.00',
    ' 10.00',
    '10.00 ',
    '10,00',
    '',
    '.50',
    '007.00',
    'NaN',
    'Infinity',
  ])('rejeita a entrada inválida "%s"', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
  });

  it('rejeita entrada que não seja string', () => {
    expect(() =>
      Money.from({ amount: 10.5 as unknown as string, currency: 'BRL' }),
    ).toThrow();
  });

  it.each(['brl', 'BR', 'BRLX', '', '123'])(
    'rejeita a moeda inválida "%s"',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        'Código de moeda inválido',
      );
    },
  );

  it('preserva a precisão de BIGINT sem usar number', () => {
    const max = Money.fromCents(9_223_372_036_854_775_807n, 'BRL');

    expect(max.toCents()).toBe(9_223_372_036_854_775_807n);
    expect(max.toJSON().amount).toBe('92233720368547758.07');
    expect(Money.from(max.toJSON()).equals(max)).toBe(true);
  });

  it('rejeita valores acima do limite BIGINT', () => {
    expect(() => Money.fromCents(9_223_372_036_854_775_808n, 'BRL')).toThrow(
      'fora do intervalo',
    );
    expect(() => brl('92233720368547758.07').add(brl('0.01'))).toThrow(
      'fora do intervalo',
    );
    expect(() => brl('92233720368547758.08')).toThrow('fora do intervalo');
  });

  it('reidrata a partir de centavos', () => {
    expect(Money.fromCents(12345n, 'USD').toJSON()).toEqual({
      amount: '123.45',
      currency: 'USD',
    });
    expect(Money.fromCents(5n, 'BRL').toJSON().amount).toBe('0.05');
  });

  it('rejeita centavos que não sejam bigint', () => {
    expect(() => Money.fromCents(10 as unknown as bigint, 'BRL')).toThrow();
  });

  it('compara e verifica igualdade', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').compareTo(brl('2.00'))).toBe(-1);
    expect(brl('2.00').compareTo(brl('1.00'))).toBe(1);
    expect(brl('2.00').compareTo(brl('2.00'))).toBe(0);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  it('rejeita operações e comparações entre moedas diferentes', () => {
    const usd = Money.from({ amount: '5.00', currency: 'USD' });

    expect(() => brl('10.00').add(usd)).toThrow('moedas diferentes');
    expect(() => brl('10.00').subtract(usd)).toThrow('moedas diferentes');
    expect(() => brl('10.00').equals(usd)).toThrow('moedas diferentes');
    expect(() => brl('10.00').isLessThan(usd)).toThrow('moedas diferentes');
  });

  it('é imutável', () => {
    const original = brl('10.00');

    original.add(brl('1.00'));

    expect(original.toJSON().amount).toBe('10.00');
    expect(Object.isFrozen(original)).toBe(true);
  });

  it('formata como texto', () => {
    expect(brl('3.00').toString()).toBe('3.00 BRL');
  });
});

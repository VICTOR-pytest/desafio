import {
  parseOpenWalletBody,
  parseWagerTransactionBody,
} from './request-parsers';

const valid = {
  provider: 'p',
  externalTransactionId: 'e1',
  playerId: 'pl',
  roundId: 'r',
  type: 'BET',
  amount: '10.00',
  currency: 'BRL',
};

describe('parseWagerTransactionBody', () => {
  it('converte um corpo válido em comando', () => {
    expect(parseWagerTransactionBody(valid, ' key-1 ')).toEqual({
      idempotencyKey: 'key-1',
      provider: 'p',
      externalTransactionId: 'e1',
      playerId: 'pl',
      roundId: 'r',
      type: 'BET',
      amount: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: undefined,
    });
  });

  it('exige o Idempotency-Key', () => {
    expect(() => parseWagerTransactionBody(valid, undefined)).toThrow(
      'Idempotency-Key',
    );
    expect(() => parseWagerTransactionBody(valid, '  ')).toThrow(
      'Idempotency-Key',
    );
  });

  it('rejeita valor monetário que não seja string', () => {
    expect(() =>
      parseWagerTransactionBody({ ...valid, amount: 10.5 }, 'k'),
    ).toThrow('amount');
  });

  it.each([[null], [[]], ['texto'], [10]])('rejeita corpo que não é objeto (%p)', (body) => {
    expect(() => parseWagerTransactionBody(body, 'k')).toThrow('objeto JSON');
  });

  it('rejeita campos desconhecidos e campos obrigatórios ausentes', () => {
    expect(() =>
      parseWagerTransactionBody({ ...valid, extra: 1 }, 'k'),
    ).toThrow('Campos não permitidos: extra');
    expect(() =>
      parseWagerTransactionBody({ ...valid, provider: undefined }, 'k'),
    ).toThrow('provider');
    expect(() =>
      parseWagerTransactionBody({ ...valid, roundId: '' }, 'k'),
    ).toThrow('roundId');
  });

  it('aceita referência opcional apenas como string', () => {
    expect(
      parseWagerTransactionBody(
        { ...valid, type: 'REFUND', referenceExternalTransactionId: 'e0' },
        'k',
      ).referenceExternalTransactionId,
    ).toBe('e0');
    expect(() =>
      parseWagerTransactionBody(
        { ...valid, referenceExternalTransactionId: 5 },
        'k',
      ),
    ).toThrow('referenceExternalTransactionId');
  });
});

describe('parseOpenWalletBody', () => {
  it('converte o corpo em comando usando a moeda da carteira', () => {
    expect(
      parseOpenWalletBody({
        playerId: 'pl',
        currency: 'BRL',
        openingBalance: '100.00',
      }),
    ).toEqual({
      playerId: 'pl',
      currency: 'BRL',
      openingBalance: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('rejeita saldo numérico e campos desconhecidos', () => {
    expect(() =>
      parseOpenWalletBody({ playerId: 'pl', currency: 'BRL', openingBalance: 100 }),
    ).toThrow('openingBalance');
    expect(() =>
      parseOpenWalletBody({
        playerId: 'pl',
        currency: 'BRL',
        openingBalance: '1.00',
        x: 1,
      }),
    ).toThrow('Campos não permitidos');
  });
});

import { Money } from '../money/money';
import { FailureCode } from './failure-code';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const external = (overrides: Record<string, unknown> = {}) =>
  WagerTransaction.receive({
    id: 'tx-001',
    provider: 'provider-1',
    externalTransactionId: 'ext-001',
    playerId: 'player-001',
    roundId: 'round-001',
    type: WagerTransactionType.BET,
    amount: brl('25.00'),
    ...overrides,
  } as Parameters<typeof WagerTransaction.receive>[0]);

describe('WagerTransaction', () => {
  it('recebe uma transação externa no estado PENDING', () => {
    const transaction = external();

    expect(transaction.id).toBe('tx-001');
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.walletId).toBeNull();
    expect(transaction.failureCode).toBeNull();
    expect(transaction.amount.toJSON().amount).toBe('25.00');
    expect(transaction.createdAt).toBeInstanceOf(Date);
  });

  it('nunca aceita OPENING como entrada externa', () => {
    expect(() =>
      external({ type: WagerTransactionType.OPENING }),
    ).toThrow('não aceito como entrada externa');
  });

  it('cria OPENING apenas pela factory interna', () => {
    const opening = WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-001',
      openingBalance: brl('0.00'),
    });

    expect(opening.type).toBe(WagerTransactionType.OPENING);
    expect(opening.provider).toBe('SYSTEM');
    expect(opening.externalTransactionId).toBe('opening:wallet-1');
    expect(opening.walletId).toBe('wallet-1');
  });

  it.each([WagerTransactionType.REFUND, WagerTransactionType.ROLLBACK])(
    '%s exige transação de referência',
    (type) => {
      expect(() => external({ type })).toThrow('exigem uma transação de referência');
      expect(() =>
        external({ type, referenceExternalTransactionId: '  ' }),
      ).toThrow('exigem uma transação de referência');
      expect(
        external({ type, referenceExternalTransactionId: 'ext-000' })
          .referenceExternalTransactionId,
      ).toBe('ext-000');
    },
  );

  it.each([
    WagerTransactionType.BET,
    WagerTransactionType.WIN,
    WagerTransactionType.LOSS,
  ])('%s não aceita transação de referência', (type) => {
    expect(() =>
      external({ type, referenceExternalTransactionId: 'ext-000' }),
    ).toThrow('Apenas REFUND e ROLLBACK');
  });

  it('rejeita campos obrigatórios vazios ou acima do limite', () => {
    expect(() => external({ id: ' ' })).toThrow();
    expect(() => external({ provider: '' })).toThrow();
    expect(() => external({ externalTransactionId: 'x'.repeat(129) })).toThrow();
    expect(() => external({ playerId: ' ' })).toThrow();
    expect(() => external({ roundId: '' })).toThrow();
  });

  it('rejeita valor zero ou negativo', () => {
    expect(() => external({ amount: Money.zero('BRL') })).toThrow(
      'O valor da transação deve ser positivo',
    );
    expect(() => external({ amount: brl('1.00').negate() })).toThrow(
      'O valor da transação deve ser positivo',
    );
  });

  it('associa a carteira uma única vez', () => {
    const transaction = external();

    transaction.bindWallet('wallet-1');
    transaction.bindWallet('wallet-1');

    expect(() => transaction.bindWallet('wallet-2')).toThrow(
      'associada a outra carteira',
    );
  });

  describe('transições de estado', () => {
    const terminalActions: Array<[string, (t: WagerTransaction) => void]> = [
      ['markProcessed', (t) => t.markProcessed()],
      ['markRejected', (t) => t.markRejected(FailureCode.INSUFFICIENT_FUNDS)],
      ['markFailed', (t) => t.markFailed(FailureCode.INSUFFICIENT_FUNDS)],
    ];

    const reach: Array<[WagerTransactionStatus, (t: WagerTransaction) => void]> = [
      [WagerTransactionStatus.PROCESSED, (t) => t.markProcessed()],
      [
        WagerTransactionStatus.REJECTED,
        (t) => t.markRejected(FailureCode.INSUFFICIENT_FUNDS),
      ],
      [
        WagerTransactionStatus.FAILED,
        (t) => t.markFailed(FailureCode.INSUFFICIENT_FUNDS),
      ],
    ];

    it.each(reach)('PENDING chega a %s', (status, apply) => {
      const transaction = external();

      apply(transaction);

      expect(transaction.status).toBe(status);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.processedAt).toBeInstanceOf(Date);
    });

    it('registra o failureCode em REJECTED e FAILED', () => {
      const rejected = external();
      rejected.markRejected(FailureCode.INSUFFICIENT_FUNDS);

      const failed = external();
      failed.markFailed(FailureCode.WALLET_NOT_FOUND);

      expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
      expect(failed.failureCode).toBe(FailureCode.WALLET_NOT_FOUND);
    });

    it('PENDING_REFERENCE é não terminal e resolve para qualquer estado final', () => {
      for (const [status, apply] of reach) {
        const transaction = external({
          type: WagerTransactionType.REFUND,
          referenceExternalTransactionId: 'ext-000',
        });

        transaction.markPendingReference();
        expect(transaction.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
        expect(transaction.isTerminal()).toBe(false);

        apply(transaction);
        expect(transaction.status).toBe(status);
      }
    });

    it.each(reach)('%s é terminal e rejeita qualquer transição posterior', (_, apply) => {
      const transaction = external();
      apply(transaction);

      for (const [, action] of terminalActions) {
        expect(() => action(transaction)).toThrow('estado terminal');
      }
      expect(() => transaction.markPendingReference()).toThrow('estado terminal');
      expect(() => transaction.bindReference('tx-ref')).toThrow('estado terminal');
    });

    it('mantém o estado inalterado após transição rejeitada', () => {
      const transaction = external();
      transaction.markProcessed();

      expect(() =>
        transaction.markRejected(FailureCode.INSUFFICIENT_FUNDS),
      ).toThrow();
      expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(transaction.failureCode).toBeNull();
    });
  });

  it('reidrata a partir de um snapshot', () => {
    const original = external();
    original.bindWallet('wallet-1');
    original.markProcessed();

    const copy = WagerTransaction.rehydrate(original.toSnapshot());

    expect(copy.toSnapshot()).toEqual(original.toSnapshot());
    expect(copy.isTerminal()).toBe(true);
  });
});

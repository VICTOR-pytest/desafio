import { LedgerDirection, LedgerEntryType } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { FailureCode } from '../wager/failure-code';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from '../wager/wager-transaction';
import { Wallet } from '../wallet/wallet';
import { WagerProcessor } from './wager-processor';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

let sequence = 0;

const incoming = (
  type: WagerTransactionType,
  amount: string,
  overrides: Record<string, unknown> = {},
) =>
  WagerTransaction.receive({
    id: `tx-${++sequence}`,
    provider: 'provider-1',
    externalTransactionId: `ext-${sequence}`,
    playerId: 'player-1',
    roundId: 'round-1',
    type,
    amount: money(amount),
    ...(type === WagerTransactionType.REFUND ||
    type === WagerTransactionType.ROLLBACK
      ? { referenceExternalTransactionId: 'ext-ref' }
      : {}),
    ...overrides,
  } as Parameters<typeof WagerTransaction.receive>[0]);

const walletWith = (amount: string) =>
  Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: money(amount),
    version: 1,
  });

describe('WagerProcessor', () => {
  let processor: WagerProcessor;
  let wallet: Wallet;
  let ids: number;

  const balance = () => wallet.balance.toJSON().amount;

  const processed = (type: WagerTransactionType, amount: string, overrides = {}) => {
    const tx = incoming(type, amount, overrides);
    tx.bindWallet('wallet-1');
    tx.markProcessed();
    return tx;
  };

  beforeEach(() => {
    ids = 0;
    processor = new WagerProcessor(() => `ledger-${++ids}`);
    wallet = walletWith('100.00');
  });

  describe('OPENING', () => {
    const opening = (amount: string) =>
      WagerTransaction.opening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        openingBalance: money(amount),
      });

    it('credita o saldo inicial e gera lançamento OPENING', () => {
      const empty = Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
      });
      const tx = opening('100.00');

      const entry = processor.process(tx, empty);

      expect(entry?.type).toBe(LedgerEntryType.OPENING);
      expect(entry?.direction).toBe(LedgerDirection.CREDIT);
      expect(empty.balance.toJSON().amount).toBe('100.00');
      expect(tx.status).toBe(WagerTransactionStatus.PROCESSED);
    });

    it('aceita saldo inicial zero com lançamento de valor zero', () => {
      const empty = Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
      });

      const entry = processor.process(opening('0.00'), empty);

      expect(entry?.amount.isZero()).toBe(true);
      expect(empty.balance.isZero()).toBe(true);
    });

    it('não altera a versão da carteira', () => {
      const empty = Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
      });

      processor.process(opening('100.00'), empty);

      expect(empty.version).toBe(1);
    });

    it('não reabre uma carteira que já tem saldo', () => {
      expect(() => processor.process(opening('10.00'), wallet)).toThrow(
        'OPENING só pode ser aplicado',
      );
      expect(balance()).toBe('100.00');
    });
  });

  describe('BET', () => {
    it('debita o valor e gera lançamento de débito', () => {
      const tx = incoming(WagerTransactionType.BET, '10.00');

      const entry = processor.process(tx, wallet);

      expect(balance()).toBe('90.00');
      expect(tx.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(entry).toMatchObject({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: tx.id,
        type: LedgerEntryType.BET,
        direction: LedgerDirection.DEBIT,
      });
      expect(entry?.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry?.balanceAfter.toJSON().amount).toBe('90.00');
    });

    it('aceita apostar exatamente o saldo', () => {
      processor.process(incoming(WagerTransactionType.BET, '100.00'), wallet);

      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejeita saldo insuficiente sem lançamento nem mudança de saldo', () => {
      const tx = incoming(WagerTransactionType.BET, '150.00');

      const entry = processor.process(tx, wallet);

      expect(entry).toBeNull();
      expect(tx.status).toBe(WagerTransactionStatus.REJECTED);
      expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
      expect(balance()).toBe('100.00');
    });
  });

  describe('WIN e LOSS', () => {
    it('WIN credita o prêmio', () => {
      const entry = processor.process(
        incoming(WagerTransactionType.WIN, '20.00'),
        wallet,
      );

      expect(balance()).toBe('120.00');
      expect(entry?.direction).toBe(LedgerDirection.CREDIT);
      expect(entry?.type).toBe(LedgerEntryType.WIN);
    });

    it('LOSS registra o resultado sem alterar saldo nem gerar lançamento', () => {
      const tx = incoming(WagerTransactionType.LOSS, '10.00');

      const entry = processor.process(tx, wallet);

      expect(entry).toBeNull();
      expect(balance()).toBe('100.00');
      expect(tx.status).toBe(WagerTransactionStatus.PROCESSED);
    });
  });

  describe('moeda e jogador', () => {
    it('rejeita transação em moeda diferente da carteira', () => {
      const tx = incoming(WagerTransactionType.BET, '10.00', {
        amount: money('10.00', 'USD'),
      });

      processor.process(tx, wallet);

      expect(tx.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
      expect(balance()).toBe('100.00');
    });

    it('rejeita transação de outro jogador', () => {
      const tx = incoming(WagerTransactionType.WIN, '10.00', {
        playerId: 'player-2',
      });

      processor.process(tx, wallet);

      expect(tx.failureCode).toBe(FailureCode.PLAYER_MISMATCH);
      expect(balance()).toBe('100.00');
    });
  });

  describe('REFUND', () => {
    const betRef = (overrides = {}) =>
      processed(WagerTransactionType.BET, '10.00', overrides);

    it('credita a reversão de uma BET processada', () => {
      const bet = betRef();
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      const entry = processor.process(refund, wallet, {
        transaction: bet,
        alreadyReversed: false,
      });

      expect(balance()).toBe('110.00');
      expect(entry?.type).toBe(LedgerEntryType.REFUND);
      expect(entry?.direction).toBe(LedgerDirection.CREDIT);
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    it('fica PENDING_REFERENCE quando a referência não existe', () => {
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      const entry = processor.process(refund, wallet, {
        transaction: null,
        alreadyReversed: false,
      });

      expect(entry).toBeNull();
      expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
      expect(refund.isTerminal()).toBe(false);
      expect(balance()).toBe('100.00');
    });

    it('fica PENDING_REFERENCE quando nenhum contexto é informado', () => {
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet);

      expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    });

    it('fica PENDING_REFERENCE enquanto a referência não foi processada', () => {
      const bet = incoming(WagerTransactionType.BET, '10.00');
      bet.bindWallet('wallet-1');
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, { transaction: bet, alreadyReversed: false });

      expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    });

    it('resolve um PENDING_REFERENCE quando a referência chega', () => {
      const refund = incoming(WagerTransactionType.REFUND, '10.00');
      processor.process(refund, wallet, { transaction: null, alreadyReversed: false });

      processor.process(refund, wallet, {
        transaction: betRef(),
        alreadyReversed: false,
      });

      expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(balance()).toBe('110.00');
    });

    it('rejeita referência rejeitada ou falha', () => {
      const rejected = incoming(WagerTransactionType.BET, '10.00');
      rejected.bindWallet('wallet-1');
      rejected.markRejected(FailureCode.INSUFFICIENT_FUNDS);
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, {
        transaction: rejected,
        alreadyReversed: false,
      });

      expect(refund.failureCode).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
      expect(balance()).toBe('100.00');
    });

    it('rejeita uma segunda reversão da mesma referência', () => {
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, {
        transaction: betRef(),
        alreadyReversed: true,
      });

      expect(refund.failureCode).toBe(FailureCode.ALREADY_REVERSED);
      expect(balance()).toBe('100.00');
    });

    it('rejeita valor diferente da referência', () => {
      const refund = incoming(WagerTransactionType.REFUND, '9.99');

      processor.process(refund, wallet, {
        transaction: betRef(),
        alreadyReversed: false,
      });

      expect(refund.failureCode).toBe(FailureCode.AMOUNT_MISMATCH);
      expect(balance()).toBe('100.00');
    });

    it.each([
      [WagerTransactionType.WIN],
      [WagerTransactionType.LOSS],
      [WagerTransactionType.REFUND],
      [WagerTransactionType.ROLLBACK],
    ])('rejeita REFUND de referência do tipo %s', (type) => {
      const reference = processed(
        type,
        '10.00',
        type === WagerTransactionType.REFUND ||
          type === WagerTransactionType.ROLLBACK
          ? { referenceExternalTransactionId: 'ext-x' }
          : {},
      );
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, {
        transaction: reference,
        alreadyReversed: false,
      });

      expect(refund.failureCode).toBe(FailureCode.REFERENCE_TYPE_NOT_ALLOWED);
    });

    it.each([
      ['provider', { provider: 'provider-2' }, FailureCode.PROVIDER_MISMATCH],
      ['jogador', { playerId: 'player-2' }, FailureCode.PLAYER_MISMATCH],
      ['rodada', { roundId: 'round-2' }, FailureCode.ROUND_MISMATCH],
      [
        'moeda',
        { amount: money('10.00', 'USD') },
        FailureCode.CURRENCY_MISMATCH,
      ],
    ])('rejeita referência com %s divergente', (_, overrides, code) => {
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, {
        transaction: betRef(overrides),
        alreadyReversed: false,
      });

      expect(refund.failureCode).toBe(code);
      expect(balance()).toBe('100.00');
    });

    it('rejeita referência de outra carteira', () => {
      const bet = incoming(WagerTransactionType.BET, '10.00');
      bet.bindWallet('wallet-other');
      bet.markProcessed();
      const refund = incoming(WagerTransactionType.REFUND, '10.00');

      processor.process(refund, wallet, { transaction: bet, alreadyReversed: false });

      expect(refund.failureCode).toBe(FailureCode.WALLET_MISMATCH);
    });
  });

  describe('ROLLBACK', () => {
    const rollback = (amount = '10.00') =>
      incoming(WagerTransactionType.ROLLBACK, amount);

    it('reverte uma BET com crédito', () => {
      const entry = processor.process(rollback(), wallet, {
        transaction: processed(WagerTransactionType.BET, '10.00'),
        alreadyReversed: false,
      });

      expect(balance()).toBe('110.00');
      expect(entry?.type).toBe(LedgerEntryType.ROLLBACK);
      expect(entry?.direction).toBe(LedgerDirection.CREDIT);
    });

    it('reverte uma WIN com débito', () => {
      const entry = processor.process(rollback('20.00'), wallet, {
        transaction: processed(WagerTransactionType.WIN, '20.00'),
        alreadyReversed: false,
      });

      expect(balance()).toBe('80.00');
      expect(entry?.direction).toBe(LedgerDirection.DEBIT);
    });

    it('reverte um REFUND com débito', () => {
      processor.process(rollback(), wallet, {
        transaction: processed(WagerTransactionType.REFUND, '10.00', {
          referenceExternalTransactionId: 'ext-x',
        }),
        alreadyReversed: false,
      });

      expect(balance()).toBe('90.00');
    });

    it('rejeita reversão que geraria saldo negativo com failureCode próprio', () => {
      const poor = walletWith('5.00');
      const tx = rollback('20.00');

      const entry = processor.process(tx, poor, {
        transaction: processed(WagerTransactionType.WIN, '20.00'),
        alreadyReversed: false,
      });

      expect(entry).toBeNull();
      expect(tx.status).toBe(WagerTransactionStatus.REJECTED);
      expect(tx.failureCode).toBe(FailureCode.ROLLBACK_NEGATIVE_BALANCE);
      expect(poor.balance.toJSON().amount).toBe('5.00');
    });

    it('permite reverter até deixar o saldo exatamente zero', () => {
      const exact = walletWith('20.00');

      processor.process(rollback('20.00'), exact, {
        transaction: processed(WagerTransactionType.WIN, '20.00'),
        alreadyReversed: false,
      });

      expect(exact.balance.isZero()).toBe(true);
    });

    it('rejeita segunda reversão, tipo não permitido e valor diferente', () => {
      const twice = rollback();
      processor.process(twice, wallet, {
        transaction: processed(WagerTransactionType.BET, '10.00'),
        alreadyReversed: true,
      });
      expect(twice.failureCode).toBe(FailureCode.ALREADY_REVERSED);

      for (const type of [WagerTransactionType.LOSS, WagerTransactionType.ROLLBACK]) {
        const tx = rollback();
        processor.process(tx, wallet, {
          transaction: processed(
            type,
            '10.00',
            type === WagerTransactionType.ROLLBACK
              ? { referenceExternalTransactionId: 'ext-x' }
              : {},
          ),
          alreadyReversed: false,
        });
        expect(tx.failureCode).toBe(FailureCode.REFERENCE_TYPE_NOT_ALLOWED);
      }

      const other = rollback('11.00');
      processor.process(other, wallet, {
        transaction: processed(WagerTransactionType.BET, '10.00'),
        alreadyReversed: false,
      });
      expect(other.failureCode).toBe(FailureCode.AMOUNT_MISMATCH);
      expect(balance()).toBe('100.00');
    });

    it('fica PENDING_REFERENCE sem referência', () => {
      const tx = rollback();

      processor.process(tx, wallet, { transaction: null, alreadyReversed: false });

      expect(tx.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    });
  });

  describe('versão da carteira', () => {
    it('aumenta uma vez por operação que altera o saldo', () => {
      processor.process(incoming(WagerTransactionType.BET, '10.00'), wallet);
      processor.process(incoming(WagerTransactionType.WIN, '5.00'), wallet);

      expect(wallet.version).toBe(3);
    });

    it('não muda em LOSS, rejeições e PENDING_REFERENCE', () => {
      processor.process(incoming(WagerTransactionType.LOSS, '10.00'), wallet);
      processor.process(incoming(WagerTransactionType.BET, '999.00'), wallet);
      processor.process(incoming(WagerTransactionType.REFUND, '10.00'), wallet, {
        transaction: null,
        alreadyReversed: false,
      });

      expect(wallet.version).toBe(1);
    });
  });

  describe('estados terminais', () => {
    it.each([
      WagerTransactionStatus.PROCESSED,
      WagerTransactionStatus.REJECTED,
      WagerTransactionStatus.FAILED,
    ])('não reprocessa uma transação %s', (status) => {
      const tx = incoming(WagerTransactionType.BET, '10.00');
      if (status === WagerTransactionStatus.PROCESSED) tx.markProcessed();
      if (status === WagerTransactionStatus.REJECTED)
        tx.markRejected(FailureCode.INSUFFICIENT_FUNDS);
      if (status === WagerTransactionStatus.FAILED)
        tx.markFailed(FailureCode.INSUFFICIENT_FUNDS);

      expect(() => processor.process(tx, wallet)).toThrow('estado terminal');
      expect(balance()).toBe('100.00');
    });
  });

  describe('invariante do ledger', () => {
    it('saldo final = saldo inicial + créditos − débitos', () => {
      const initial = wallet.balance.toCents();
      const entries = [
        processor.process(incoming(WagerTransactionType.BET, '30.00'), wallet),
        processor.process(incoming(WagerTransactionType.WIN, '45.50'), wallet),
        processor.process(incoming(WagerTransactionType.BET, '200.00'), wallet),
        processor.process(incoming(WagerTransactionType.LOSS, '30.00'), wallet),
      ].filter((entry) => entry !== null);

      const net = entries.reduce((sum, entry) => sum + entry.signedAmountInCents(), 0n);

      expect(wallet.balance.toCents()).toBe(initial + net);
      expect(balance()).toBe('115.50');
    });
  });
});

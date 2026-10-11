import type { MikroORM } from '@mikro-orm/postgresql';
import {
  IdempotencyConflictError,
  RetryableError,
  WalletAlreadyExistsError,
} from '../../src/application/errors';
import { DomainError } from '../../src/domain/domain-error';
import { FailureCode } from '../../src/domain/wager/failure-code';
import { TransactionalContext } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  balanceOf,
  buildHarness,
  command,
  createTestOrm,
  Harness,
  ledgerNet,
  nextId,
  resetDatabase,
  rows,
  scalar,
} from './support';

describe('núcleo financeiro (PostgreSQL real)', () => {
  let orm: MikroORM;
  let h: Harness;

  beforeAll(async () => {
    orm = await createTestOrm();
    await resetDatabase(orm);
    h = buildHarness(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  const newWallet = async (balance = '100.00', currency = 'BRL') => {
    const playerId = nextId('player');
    const wallet = await h.openWallet.execute({
      playerId,
      currency,
      openingBalance: { amount: balance, currency },
    });
    return { playerId, walletId: wallet.walletId };
  };

  const countFor = (table: string, column: string, value: string) =>
    scalar(h.em, `select count(*) from ${table} where ${column} = ?`, [value]);

  describe('OPENING', () => {
    it('cria carteira, transação OPENING, lançamento e eventos de forma atômica', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      expect(await balanceOf(h, playerId)).toBe('100.00');

      const entries = await rows(
        h.em,
        `select entry_type, direction, amount_in_cents::text a, balance_before_in_cents::text b0, balance_after_in_cents::text b1
         from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
      );
      expect(entries).toEqual([
        { entry_type: 'OPENING', direction: 'CREDIT', a: '10000', b0: '0', b1: '10000' },
      ]);

      const [transaction] = await rows(
        h.em,
        `select type, status, provider from wager_transactions where wallet_id = ?`,
        [walletId],
      );
      expect(transaction).toEqual({
        type: 'OPENING',
        status: 'PROCESSED',
        provider: 'SYSTEM',
      });

      const events = await rows(
        h.em,
        `select event_type from outbox_messages where payload->>'walletId' = ? order by event_type`,
        [walletId],
      );
      expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged']);
    });

    it('aceita saldo inicial zero registrando OPENING de valor zero', async () => {
      const { walletId } = await newWallet('0.00');

      expect(await ledgerNet(h.em, walletId)).toBe('0');
      expect(await countFor('wallet_ledger_entries', 'wallet_id', walletId)).toBe('1');
      expect(
        await scalar(h.em, `select count(*) from outbox_messages where payload->>'walletId' = ?`, [walletId]),
      ).toBe('0');
    });

    it('rejeita uma segunda carteira para o mesmo jogador e moeda', async () => {
      const { playerId } = await newWallet();

      await expect(
        h.openWallet.execute({
          playerId,
          currency: 'BRL',
          openingBalance: { amount: '1.00', currency: 'BRL' },
        }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    });

    it('permite carteiras em moedas diferentes para o mesmo jogador', async () => {
      const { playerId } = await newWallet('10.00', 'BRL');

      await h.openWallet.execute({
        playerId,
        currency: 'USD',
        openingBalance: { amount: '5.00', currency: 'USD' },
      });

      expect(await balanceOf(h, playerId, 'USD')).toBe('5.00');
      expect(await balanceOf(h, playerId, 'BRL')).toBe('10.00');
    });

    it('rejeita saldo inicial em moeda diferente da carteira', async () => {
      await expect(
        h.openWallet.execute({
          playerId: nextId('player'),
          currency: 'BRL',
          openingBalance: { amount: '1.00', currency: 'USD' },
        }),
      ).rejects.toThrow('mesma da carteira');
    });

    it('com 10 aberturas concorrentes, só uma é criada', async () => {
      const playerId = nextId('player');
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          h.openWallet.execute({
            playerId,
            currency: 'BRL',
            openingBalance: { amount: '50.00', currency: 'BRL' },
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .every((r) => (r as PromiseRejectedResult).reason instanceof WalletAlreadyExistsError),
      ).toBe(true);
      expect(await countFor('wallets', 'player_id', playerId)).toBe('1');
      expect(await balanceOf(h, playerId)).toBe('50.00');
    });

    it('nunca aceita OPENING como transação externa', async () => {
      const { playerId } = await newWallet();

      await expect(
        h.process.execute(
          command(playerId, 'OPENING' as any, '10.00'),
        ),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('BET, WIN e LOSS', () => {
    it('BET aprovada atualiza saldo, ledger e eventos', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      const result = await h.process.execute(command(playerId, 'BET', '30.00'));

      expect(result).toMatchObject({ status: 'PROCESSED', failureCode: null, idempotentReplay: false });
      expect(await balanceOf(h, playerId)).toBe('70.00');
      expect(await ledgerNet(h.em, walletId)).toBe('7000');

      const events = await rows(
        h.em,
        `select event_type from outbox_messages
         where aggregate_id = ? or payload->>'transactionId' = ? order by event_type`,
        [result.transactionId, result.transactionId],
      );
      expect(events.map((e) => e.event_type)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    it('BET com saldo insuficiente é rejeitada sem lançamento nem mutação', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      const result = await h.process.execute(command(playerId, 'BET', '150.00'));

      expect(result).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.INSUFFICIENT_FUNDS,
      });
      expect(await balanceOf(h, playerId)).toBe('100.00');
      expect(await countFor('wallet_ledger_entries', 'wallet_id', walletId)).toBe('1');

      const [event] = await rows(
        h.em,
        `select event_type, payload->>'failureCode' code from outbox_messages where aggregate_id = ?`,
        [result.transactionId],
      );
      expect(event).toEqual({
        event_type: 'WagerTransactionRejected',
        code: 'INSUFFICIENT_FUNDS',
      });
    });

    it('WIN credita e LOSS não altera o saldo nem cria lançamento', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      await h.process.execute(command(playerId, 'WIN', '25.50'));
      const loss = await h.process.execute(command(playerId, 'LOSS', '10.00'));

      expect(loss.status).toBe('PROCESSED');
      expect(await balanceOf(h, playerId)).toBe('125.50');
      expect(await countFor('wallet_ledger_entries', 'wallet_id', walletId)).toBe('2');
    });

    it('rejeita transação para carteira inexistente sem criar carteira', async () => {
      const playerId = nextId('ghost');

      const result = await h.process.execute(command(playerId, 'BET', '10.00'));

      expect(result).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.WALLET_NOT_FOUND,
      });
      expect(await countFor('wallets', 'player_id', playerId)).toBe('0');
    });

    it('rejeita payload de domínio inválido antes de qualquer persistência', async () => {
      const { playerId } = await newWallet();
      const before = await scalar(h.em, 'select count(*) from wager_transactions');

      await expect(
        h.process.execute(command(playerId, 'BET', '10.5')),
      ).rejects.toBeInstanceOf(DomainError);
      await expect(
        h.process.execute(command(playerId, 'BET', '10.00', { idempotencyKey: ' ' })),
      ).rejects.toBeInstanceOf(DomainError);
      await expect(
        h.process.execute(
          command(playerId, 'REFUND', '10.00'),
        ),
      ).rejects.toBeInstanceOf(DomainError);

      expect(await scalar(h.em, 'select count(*) from wager_transactions')).toBe(before);
    });
  });

  describe('REFUND e ROLLBACK', () => {
    const betThen = async (balance = '100.00', amount = '40.00') => {
      const { playerId, walletId } = await newWallet(balance);
      const bet = command(playerId, 'BET', amount);
      await h.process.execute(bet);
      return { playerId, walletId, bet };
    };

    const reversal = (
      playerId: string,
      type: 'REFUND' | 'ROLLBACK',
      amount: string,
      reference: string,
      overrides = {},
    ) =>
      command(playerId, type, amount, {
        referenceExternalTransactionId: reference,
        ...overrides,
      });

    it('REFUND válido credita o valor da BET exatamente uma vez', async () => {
      const { playerId, bet } = await betThen();

      const refund = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId),
      );
      const second = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId),
      );

      expect(refund.status).toBe('PROCESSED');
      expect(second).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.ALREADY_REVERSED,
      });
      expect(await balanceOf(h, playerId)).toBe('100.00');
    });

    it('REFUND com valor diferente da referência é rejeitado', async () => {
      const { playerId, bet } = await betThen();

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '39.99', bet.externalTransactionId),
      );

      expect(result.failureCode).toBe(FailureCode.AMOUNT_MISMATCH);
      expect(await balanceOf(h, playerId)).toBe('60.00');
    });

    it('REFUND de uma WIN não é permitido', async () => {
      const { playerId } = await newWallet();
      const win = command(playerId, 'WIN', '10.00');
      await h.process.execute(win);

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '10.00', win.externalTransactionId),
      );

      expect(result.failureCode).toBe(FailureCode.REFERENCE_TYPE_NOT_ALLOWED);
    });

    it('ROLLBACK de BET credita uma única vez e rejeita a repetição do mesmo tipo', async () => {
      const { playerId, bet } = await betThen();

      const rollback = await h.process.execute(
        reversal(playerId, 'ROLLBACK', '40.00', bet.externalTransactionId),
      );
      const again = await h.process.execute(
        reversal(playerId, 'ROLLBACK', '40.00', bet.externalTransactionId),
      );

      expect(rollback.status).toBe('PROCESSED');
      expect(again.failureCode).toBe(FailureCode.ALREADY_REVERSED);
      expect(await balanceOf(h, playerId)).toBe('100.00');
    });

    it('a unicidade vale por tipo de reversão: REFUND e ROLLBACK da mesma BET são independentes', async () => {
      const { playerId, bet } = await betThen();

      const refund = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId),
      );
      const rollback = await h.process.execute(
        reversal(playerId, 'ROLLBACK', '40.00', bet.externalTransactionId),
      );

      expect([refund.status, rollback.status]).toEqual(['PROCESSED', 'PROCESSED']);
      expect(await balanceOf(h, playerId)).toBe('140.00');
    });

    it('ROLLBACK de WIN debita o prêmio', async () => {
      const { playerId } = await newWallet('10.00');
      const win = command(playerId, 'WIN', '20.00');
      await h.process.execute(win);

      const rollback = await h.process.execute(
        reversal(playerId, 'ROLLBACK', '20.00', win.externalTransactionId),
      );

      expect(rollback.status).toBe('PROCESSED');
      expect(await balanceOf(h, playerId)).toBe('10.00');
    });

    it('ROLLBACK que geraria saldo negativo é rejeitado com failureCode próprio', async () => {
      const { playerId } = await newWallet('0.00');
      const win = command(playerId, 'WIN', '20.00');
      await h.process.execute(win);
      await h.process.execute(command(playerId, 'BET', '15.00'));

      const rollback = await h.process.execute(
        reversal(playerId, 'ROLLBACK', '20.00', win.externalTransactionId),
      );

      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: FailureCode.ROLLBACK_NEGATIVE_BALANCE,
      });
      expect(await balanceOf(h, playerId)).toBe('5.00');
    });

    it('referência inexistente fica PENDING_REFERENCE sem efeito financeiro', async () => {
      const { playerId, walletId } = await newWallet();

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '10.00', 'nao-existe'),
      );

      expect(result).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null });
      expect(await balanceOf(h, playerId)).toBe('100.00');
      expect(await countFor('wallet_ledger_entries', 'wallet_id', walletId)).toBe('1');

      const [event] = await rows(
        h.em,
        `select event_type from outbox_messages where aggregate_id = ?`,
        [result.transactionId],
      );
      expect(event.event_type).toBe('WagerTransactionPendingReference');
    });

    it('rejeita reversão em moeda diferente da referência', async () => {
      const { playerId, bet } = await betThen();
      await h.openWallet.execute({
        playerId,
        currency: 'USD',
        openingBalance: { amount: '0.00', currency: 'USD' },
      });

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId, {
          amount: { amount: '40.00', currency: 'USD' },
        }),
      );

      expect(result.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
      expect(await balanceOf(h, playerId, 'USD')).toBe('0.00');
    });

    it('rejeita reversão de outro jogador ou de outra rodada', async () => {
      const { playerId, bet } = await betThen();
      const other = await newWallet('100.00');

      const wrongPlayer = await h.process.execute(
        reversal(other.playerId, 'REFUND', '40.00', bet.externalTransactionId),
      );
      const wrongRound = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId, {
          roundId: 'round-outra',
        }),
      );

      expect(wrongPlayer.failureCode).toBe(FailureCode.PLAYER_MISMATCH);
      expect(wrongRound.failureCode).toBe(FailureCode.ROUND_MISMATCH);
      expect(await balanceOf(h, other.playerId)).toBe('100.00');
      expect(await balanceOf(h, playerId)).toBe('60.00');
    });

    it('rejeita reversão de outro provider (referência inexistente nesse provider)', async () => {
      const { playerId, bet } = await betThen();

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '40.00', bet.externalTransactionId, {
          provider: 'provider-2',
        }),
      );

      expect(result.status).toBe('PENDING_REFERENCE');
      expect(await balanceOf(h, playerId)).toBe('60.00');
    });

    it('rejeita reversão de uma referência que foi rejeitada', async () => {
      const { playerId } = await newWallet('5.00');
      const bet = command(playerId, 'BET', '50.00');
      await h.process.execute(bet);

      const result = await h.process.execute(
        reversal(playerId, 'REFUND', '50.00', bet.externalTransactionId),
      );

      expect(result.failureCode).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
      expect(await balanceOf(h, playerId)).toBe('5.00');
    });
  });

  describe('idempotência', () => {
    it('reenvio idêntico devolve o resultado original sem novo efeito', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');

      const first = await h.process.execute(bet);
      const second = await h.process.execute({ ...bet });

      expect(second).toEqual({ ...first, idempotentReplay: true });
      expect(first.idempotentReplay).toBe(false);
      expect(await balanceOf(h, playerId)).toBe('90.00');
      expect(await countFor('wallet_ledger_entries', 'wallet_id', walletId)).toBe('2');
      expect(await countFor('outbox_messages', 'aggregate_id', first.transactionId)).toBe('1');
    });

    it('replay de uma rejeição devolve a mesma rejeição', async () => {
      const { playerId } = await newWallet('1.00');
      const bet = command(playerId, 'BET', '10.00');

      const first = await h.process.execute(bet);
      const second = await h.process.execute(bet);

      expect(first.status).toBe('REJECTED');
      expect(second).toEqual({ ...first, idempotentReplay: true });
    });

    it('mesma chave com payload diferente gera conflito e nenhum efeito', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      await h.process.execute(bet);

      await expect(
        h.process.execute({ ...bet, amount: { amount: '99.00', currency: 'BRL' } }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        h.process.execute({ ...bet, roundId: 'round-2' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await balanceOf(h, playerId)).toBe('90.00');
    });

    it('a ordem das chaves do payload não altera a identidade', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      await h.process.execute(bet);

      const reordered = {
        type: bet.type,
        amount: { currency: 'BRL', amount: '10.00' },
        roundId: bet.roundId,
        playerId: bet.playerId,
        externalTransactionId: bet.externalTransactionId,
        provider: bet.provider,
        idempotencyKey: bet.idempotencyKey,
      } as typeof bet;

      expect((await h.process.execute(reordered)).idempotentReplay).toBe(true);
    });

    it('mesma identidade externa com outra chave e mesmo payload é replay', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      const first = await h.process.execute(bet);

      const replay = await h.process.execute({ ...bet, idempotencyKey: nextId('outra') });

      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(await balanceOf(h, playerId)).toBe('90.00');
    });

    it('mesma identidade externa com payload diferente é conflito', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      await h.process.execute(bet);

      await expect(
        h.process.execute({
          ...bet,
          idempotencyKey: nextId('outra'),
          amount: { amount: '20.00', currency: 'BRL' },
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('chaves de provedores diferentes são independentes', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');

      await h.process.execute(bet);
      const other = await h.process.execute({ ...bet, provider: 'provider-2' });

      expect(other.idempotentReplay).toBe(false);
      expect(await balanceOf(h, playerId)).toBe('80.00');
    });

    it('redelivery da mesma mensagem do inbox não duplica efeitos', async () => {
      const { playerId } = await newWallet('100.00');
      const messageId = nextId('sqs');
      const bet = {
        ...command(playerId, 'BET', '10.00'),
        inbox: { source: 'sqs', messageId, payload: { any: 'thing' } },
      };

      const first = await h.process.execute(bet);
      const second = await h.process.execute(bet);

      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(await balanceOf(h, playerId)).toBe('90.00');

      const inbox = await rows(
        h.em,
        `select transaction_id, processed_at is not null as done from inbox_messages where message_id = ?`,
        [messageId],
      );
      expect(inbox).toEqual([{ transaction_id: first.transactionId, done: true }]);
    });
  });

  describe('atomicidade', () => {
    class FailingUnitOfWork extends PostgresUnitOfWork {
      constructor(
        em: EntityManager,
        private readonly failAt: 'outbox' | 'ledger' | 'wallet',
      ) {
        super(em);
      }

      protected override createContext(em: EntityManager): TransactionalContext {
        const context = super.createContext(em);
        const boom = async () => {
          throw new Error('falha injetada');
        };

        if (this.failAt === 'outbox') context.outbox.insert = boom;
        if (this.failAt === 'ledger') context.ledger.insert = boom;
        if (this.failAt === 'wallet') context.wallets.saveBalance = boom;

        return context;
      }
    }

    const snapshot = async (playerId: string, walletId: string) => ({
      balance: await balanceOf(h, playerId),
      transactions: await countFor('wager_transactions', 'wallet_id', walletId),
      ledger: await countFor('wallet_ledger_entries', 'wallet_id', walletId),
      outbox: await scalar(h.em, 'select count(*) from outbox_messages'),
    });

    it.each(['outbox', 'ledger', 'wallet'] as const)(
      'falha em %s desfaz transação, ledger, saldo e eventos',
      async (failAt) => {
        const { playerId, walletId } = await newWallet('100.00');
        const before = await snapshot(playerId, walletId);
        const failing = buildHarness(orm, new FailingUnitOfWork(h.em, failAt));
        const bet = {
          ...command(playerId, 'BET', '10.00'),
          inbox: { source: 'sqs', messageId: nextId('sqs'), payload: {} },
        };

        await expect(failing.process.execute(bet)).rejects.toThrow('falha injetada');

        expect(await snapshot(playerId, walletId)).toEqual(before);
        expect(
          await scalar(h.em, `select count(*) from inbox_messages where message_id = ?`, [
            bet.inbox.messageId,
          ]),
        ).toBe('0');

        const retried = await h.process.execute(bet);
        expect(retried).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
        expect(await balanceOf(h, playerId)).toBe('90.00');
      },
    );

    it('falha na abertura da carteira não deixa carteira nem lançamento', async () => {
      const failing = buildHarness(orm, new FailingUnitOfWork(h.em, 'ledger'));
      const playerId = nextId('player');

      await expect(
        failing.openWallet.execute({
          playerId,
          currency: 'BRL',
          openingBalance: { amount: '10.00', currency: 'BRL' },
        }),
      ).rejects.toThrow('falha injetada');

      expect(await countFor('wallets', 'player_id', playerId)).toBe('0');
      expect(await countFor('wager_transactions', 'player_id', playerId)).toBe('0');
    });
  });

  describe('concorrência', () => {
    it('duas BETs simultâneas de 80,00 sobre 100,00: uma processada, uma rejeitada', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      const results = await Promise.all([
        h.process.execute(command(playerId, 'BET', '80.00')),
        h.process.execute(command(playerId, 'BET', '80.00')),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe(
        FailureCode.INSUFFICIENT_FUNDS,
      );
      expect(await balanceOf(h, playerId)).toBe('20.00');
      expect(
        await scalar(
          h.em,
          `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`,
          [walletId],
        ),
      ).toBe('1');
    });

    it('dez BETs concorrentes de 60,00 sobre 100,00: só uma é aceita', async () => {
      const { playerId } = await newWallet('100.00');

      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.process.execute(command(playerId, 'BET', '60.00'))),
      );

      expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(9);
      expect(await balanceOf(h, playerId)).toBe('40.00');
    });

    it('cinquenta submissões paralelas da mesma operação geram um único efeito', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');

      const results = await Promise.all(
        Array.from({ length: 50 }, () => h.process.execute({ ...bet })),
      );

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(await balanceOf(h, playerId)).toBe('90.00');
      expect(
        await scalar(
          h.em,
          `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`,
          [walletId],
        ),
      ).toBe('1');
      expect(await countFor('wager_transactions', 'external_transaction_id', bet.externalTransactionId)).toBe('1');
    });

    it('cinquenta submissões paralelas para carteira inexistente geram uma única transação', async () => {
      const playerId = nextId('ghost');
      const bet = command(playerId, 'BET', '10.00');

      const results = await Promise.all(
        Array.from({ length: 50 }, () => h.process.execute({ ...bet })),
      );

      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(await countFor('wager_transactions', 'external_transaction_id', bet.externalTransactionId)).toBe('1');
    });

    it('registra métricas de duplicidade sob corrida', async () => {
      const metrics = new MetricsRegistry();
      const observed = new ProcessWagerTransactionUseCase(
        h.unitOfWork,
        undefined,
        undefined,
        { metrics, logger: new JsonLogger(() => undefined) },
      );
      const bet = command(nextId('ghost'), 'BET', '10.00');

      await Promise.all(Array.from({ length: 50 }, () => observed.execute({ ...bet })));

      expect(metrics.counter('wager_transactions_total', { status: 'REJECTED', type: 'BET' })).toBe(1);
      expect(metrics.counter('wager_duplicates_total', { source: 'http' })).toBe(49);
    });

    it('registra métricas de retry e de conflito de lock quando há erro transitório', async () => {
      const metrics = new MetricsRegistry();
      let calls = 0;
      const transient = {
        run: <T>(work: (context: TransactionalContext) => Promise<T>): Promise<T> => {
          calls++;

          if (calls === 1) return Promise.reject(new RetryableError('unique', 'algum_indice'));
          if (calls === 2) return Promise.reject(new RetryableError('deadlock'));

          return h.unitOfWork.run(work);
        },
      };
      const { playerId, walletId } = await newWallet('100.00');
      const observed = new ProcessWagerTransactionUseCase(
        transient,
        undefined,
        undefined,
        { metrics, logger: new JsonLogger(() => undefined) },
      );

      const result = await observed.execute(command(playerId, 'BET', '10.00'));

      expect(result.status).toBe('PROCESSED');
      expect(calls).toBe(3);
      expect(metrics.counter('wager_retries_total', { reason: 'unique_violation' })).toBe(1);
      expect(metrics.counter('wager_retries_total', { reason: 'lock_conflict' })).toBe(1);
      expect(metrics.counter('wager_lock_conflicts_total')).toBe(1);
      expect(await balanceOf(h, playerId)).toBe('90.00');
      expect(
        await scalar(h.em, `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`, [walletId]),
      ).toBe('1');
    });

    it('reversões concorrentes da mesma BET: uma por tipo é aplicada', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '40.00');
      await h.process.execute(bet);
      const reverse = (type: 'REFUND' | 'ROLLBACK') =>
        h.process.execute(
          command(playerId, type, '40.00', {
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );

      const results = await Promise.all([
        reverse('REFUND'),
        reverse('ROLLBACK'),
        reverse('REFUND'),
        reverse('ROLLBACK'),
      ]);

      expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(2);
      expect(
        results.filter((r) => r.failureCode === FailureCode.ALREADY_REVERSED),
      ).toHaveLength(2);
      expect(await balanceOf(h, playerId)).toBe('140.00');
    });

    it('operações concorrentes mistas mantêm saldo = soma do ledger', async () => {
      const { playerId, walletId } = await newWallet('200.00');
      const types = ['BET', 'WIN', 'BET', 'LOSS', 'WIN', 'BET'] as const;

      await Promise.all(
        Array.from({ length: 60 }, (_, index) =>
          h.process.execute(command(playerId, types[index % types.length], '7.30')),
        ),
      );

      const balance = await scalar(
        h.em,
        `select balance_in_cents::text from wallets where id = ?`,
        [walletId],
      );
      expect(balance).toBe(await ledgerNet(h.em, walletId));
      expect(BigInt(balance) >= 0n).toBe(true);
    });
  });

  describe('invariantes e persistência', () => {
    it('saldo = saldo inicial + créditos − débitos após uma sequência de operações', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const win = command(playerId, 'WIN', '33.33');

      await h.process.execute(command(playerId, 'BET', '12.34'));
      await h.process.execute(win);
      await h.process.execute(command(playerId, 'BET', '500.00'));
      await h.process.execute(
        command(playerId, 'ROLLBACK', '33.33', {
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );
      await h.process.execute(command(playerId, 'LOSS', '12.34'));

      const stored = await scalar(
        h.em,
        `select balance_in_cents::text from wallets where id = ?`,
        [walletId],
      );
      expect(stored).toBe(await ledgerNet(h.em, walletId));
      expect(stored).toBe('8766');
    });

    it('a cadeia de saldos do ledger é contínua', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      for (const amount of ['10.00', '20.00', '5.55']) {
        await h.process.execute(command(playerId, 'BET', amount));
        await h.process.execute(command(playerId, 'WIN', '1.11'));
      }

      const chain = await rows(
        h.em,
        `select balance_before_in_cents::text b0, balance_after_in_cents::text b1
         from wallet_ledger_entries where wallet_id = ? order by created_at, id`,
        [walletId],
      );
      const byBefore = new Map(chain.map((row) => [row.b0, row.b1]));
      let cursor = '0';
      for (let i = 0; i < chain.length; i++) {
        const next = byBefore.get(cursor);
        expect(next).toBeDefined();
        cursor = next as string;
      }
      expect(cursor).toBe(await scalar(h.em, `select balance_in_cents::text from wallets where id = ?`, [walletId]));
    });

    it('os dados persistem após reiniciar a aplicação', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      const first = await h.process.execute(bet);

      const restarted = await createTestOrm();
      try {
        const after = buildHarness(restarted);

        expect(await balanceOf(after, playerId)).toBe('90.00');
        expect(await after.process.execute(bet)).toEqual({ ...first, idempotentReplay: true });
        expect(await balanceOf(after, playerId)).toBe('90.00');
      } finally {
        await restarted.close();
      }
    });
  });
});

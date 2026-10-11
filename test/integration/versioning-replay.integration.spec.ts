import type { MikroORM } from '@mikro-orm/postgresql';
import { RetryableError } from '../../src/application/errors';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { PostgresWalletRepository } from '../../src/infrastructure/database/repositories/postgres-wallet.repository';
import {
  buildHarness,
  command,
  createTestOrm,
  Harness,
  nextId,
  resetDatabase,
  rows,
  scalar,
} from './support';

describe('versão da carteira e replay com snapshot (PostgreSQL real)', () => {
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

  const newWallet = async (balance = '100.00') => {
    const playerId = nextId('player');
    const wallet = await h.openWallet.execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: balance, currency: 'BRL' },
    });
    return { playerId, walletId: wallet.walletId };
  };

  const versionOf = async (walletId: string) =>
    Number(await scalar(h.em, `select version from wallets where id = ?`, [walletId]));

  describe('versão', () => {
    it('começa em 1, inclusive com saldo inicial, e é devolvida na abertura', async () => {
      const playerId = nextId('player');

      const wallet = await h.openWallet.execute({
        playerId,
        currency: 'BRL',
        openingBalance: { amount: '100.00', currency: 'BRL' },
      });

      expect(wallet.version).toBe(1);
      expect(await versionOf(wallet.walletId)).toBe(1);
      expect((await h.getWallet.byId(wallet.walletId)).version).toBe(1);
    });

    it('aumenta uma unidade por operação que altera o saldo', async () => {
      const { playerId, walletId } = await newWallet();

      await h.process.execute(command(playerId, 'BET', '10.00'));
      expect(await versionOf(walletId)).toBe(2);

      await h.process.execute(command(playerId, 'WIN', '5.00'));
      expect(await versionOf(walletId)).toBe(3);
    });

    it('não muda em LOSS, rejeições, PENDING_REFERENCE e replays', async () => {
      const { playerId, walletId } = await newWallet('10.00');
      const bet = command(playerId, 'BET', '5.00');
      await h.process.execute(bet);
      const before = await versionOf(walletId);

      await h.process.execute(command(playerId, 'LOSS', '5.00'));
      await h.process.execute(command(playerId, 'BET', '999.00'));
      await h.process.execute(
        command(playerId, 'REFUND', '1.00', { referenceExternalTransactionId: 'ainda-nao-chegou' }),
      );
      await h.process.execute({ ...bet });
      await h.process.execute(command(nextId('ghost'), 'BET', '1.00'));

      expect(await versionOf(walletId)).toBe(before);
    });

    it('versão = 1 + número de lançamentos que não são OPENING', async () => {
      const { playerId, walletId } = await newWallet('200.00');
      const bet = command(playerId, 'BET', '10.00');
      await h.process.execute(bet);
      await h.process.execute(command(playerId, 'WIN', '3.00'));
      await h.process.execute(
        command(playerId, 'REFUND', '10.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      await h.process.execute(command(playerId, 'LOSS', '1.00'));

      expect(await versionOf(walletId)).toBe(
        1 +
          Number(
            await scalar(
              h.em,
              `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type <> 'OPENING'`,
              [walletId],
            ),
          ),
      );
    });

    it('com 40 BETs concorrentes, a versão final = 1 + processadas e nenhuma versão se repete', async () => {
      const { playerId, walletId } = await newWallet('100.00');

      const results = await Promise.all(
        Array.from({ length: 40 }, () => h.process.execute(command(playerId, 'BET', '5.00'))),
      );

      const processed = results.filter((r) => r.status === 'PROCESSED');
      const versions = processed.map((r) => r.wallet!.version);

      expect(processed).toHaveLength(20);
      expect(new Set(versions).size).toBe(20);
      expect(Math.max(...versions)).toBe(21);
      expect(await versionOf(walletId)).toBe(21);
    });

    it('protege contra lost update: salvar com versão desatualizada falha sem alterar o saldo', async () => {
      const { walletId } = await newWallet('50.00');
      const repository = new PostgresWalletRepository(h.em);
      const stale = Wallet.rehydrate({
        id: walletId,
        playerId: 'x',
        currency: 'BRL',
        balance: Money.from({ amount: '1.00', currency: 'BRL' }),
        version: 6,
      });

      await expect(repository.saveBalance(stale, 5)).rejects.toBeInstanceOf(RetryableError);
      expect(await scalar(h.em, `select balance_in_cents::text from wallets where id = ?`, [walletId])).toBe('5000');
      expect(await versionOf(walletId)).toBe(1);
    });

    it('o banco rejeita versão menor que 1', async () => {
      const { walletId } = await newWallet();

      await expect(
        h.em.execute(`update wallets set version = 0 where id = ?`, [walletId], 'run'),
      ).rejects.toMatchObject({ constraint: 'wallets_version_positive' });
    });
  });

  describe('replay idempotente', () => {
    it('devolve o saldo e a versão originais, não os atuais', async () => {
      const { playerId } = await newWallet('100.00');
      const first = command(playerId, 'BET', '10.00');

      const original = await h.process.execute(first);
      await h.process.execute(command(playerId, 'BET', '20.00'));
      const replay = await h.process.execute({ ...first });

      expect(original.wallet).toMatchObject({ balance: { amount: '90.00' }, version: 2 });
      expect(replay).toEqual({ ...original, idempotentReplay: true });
      expect(replay.wallet?.balance.amount).toBe('90.00');
      expect((await h.getWallet.execute(playerId, 'BRL')).balance.amount).toBe('70.00');
    });

    it('o campo se chama idempotentReplay e é falso na primeira resposta', async () => {
      const { playerId } = await newWallet();
      const bet = command(playerId, 'BET', '1.00');

      const first = await h.process.execute(bet);
      const second = await h.process.execute(bet);

      expect(first.idempotentReplay).toBe(false);
      expect(second.idempotentReplay).toBe(true);
      expect('replayed' in first).toBe(false);
    });

    it('replay de rejeição preserva o saldo observado na época', async () => {
      const { playerId } = await newWallet('5.00');
      const rejected = command(playerId, 'BET', '50.00');

      const original = await h.process.execute(rejected);
      await h.process.execute(command(playerId, 'WIN', '100.00'));
      const replay = await h.process.execute(rejected);

      expect(original.status).toBe('REJECTED');
      expect(replay.wallet?.balance.amount).toBe('5.00');
      expect(replay.wallet?.version).toBe(1);
    });

    it('replay de PENDING_REFERENCE devolve a resposta original mesmo depois de resolvida', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      const refund = command(playerId, 'REFUND', '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      const original = await h.process.execute(refund);
      await h.process.execute(bet);

      const replay = await h.process.execute(refund);

      expect(original.status).toBe('PENDING_REFERENCE');
      expect(replay).toEqual({ ...original, idempotentReplay: true });
    });

    it('replay não cria débito, crédito, lançamento nem evento', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      await h.process.execute(bet);
      const counts = async () => ({
        ledger: await scalar(h.em, `select count(*) from wallet_ledger_entries where wallet_id = ?`, [walletId]),
        events: await scalar(h.em, `select count(*) from outbox_messages`),
        transactions: await scalar(h.em, `select count(*) from wager_transactions where wallet_id = ?`, [walletId]),
        version: await versionOf(walletId),
      });
      const before = await counts();

      for (let i = 0; i < 5; i++) await h.process.execute({ ...bet });

      expect(await counts()).toEqual(before);
    });

    it('mesma chave com payload divergente continua gerando conflito', async () => {
      const { playerId } = await newWallet();
      const bet = command(playerId, 'BET', '1.00');
      await h.process.execute(bet);

      await expect(
        h.process.execute({ ...bet, amount: { amount: '2.00', currency: 'BRL' } }),
      ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
    });

    it('linhas anteriores ao snapshot respondem com o estado persistido', async () => {
      const { playerId } = await newWallet();
      const bet = command(playerId, 'BET', '1.00');
      const original = await h.process.execute(bet);
      await h.em.execute(
        `update wager_transactions set response_snapshot = null where id = ?`,
        [original.transactionId],
        'run',
      );

      const replay = await h.process.execute(bet);

      expect(replay).toMatchObject({
        transactionId: original.transactionId,
        status: 'PROCESSED',
        idempotentReplay: true,
        wallet: null,
      });
    });

    it('persiste o snapshot em wager_transactions', async () => {
      const { playerId } = await newWallet('100.00');
      const bet = command(playerId, 'BET', '10.00');
      const result = await h.process.execute(bet);

      const [row] = await rows(
        h.em,
        `select response_snapshot from wager_transactions where id = ?`,
        [result.transactionId],
      );

      expect(row.response_snapshot).toEqual({
        status: 'PROCESSED',
        failureCode: null,
        wallet: {
          walletId: result.wallet!.walletId,
          balance: { amount: '90.00', currency: 'BRL' },
          version: 2,
        },
      });
    });

    it('com walletId informado, valida jogador e moeda da carteira', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      const other = await newWallet('100.00');

      const ok = await h.process.execute(command(playerId, 'BET', '5.00', { walletId }));
      const wrongPlayer = await h.process.execute(command(other.playerId, 'BET', '5.00', { walletId }));
      const wrongCurrency = await h.process.execute(
        command(playerId, 'BET', '5.00', { walletId, amount: { amount: '5.00', currency: 'USD' } }),
      );
      const missing = await h.process.execute(
        command(playerId, 'BET', '5.00', { walletId: '00000000-0000-0000-0000-000000000000' }),
      );

      expect(ok.status).toBe('PROCESSED');
      expect(wrongPlayer.failureCode).toBe('PLAYER_MISMATCH');
      expect(wrongCurrency.failureCode).toBe('CURRENCY_MISMATCH');
      expect(missing.failureCode).toBe('WALLET_NOT_FOUND');
      expect(await versionOf(walletId)).toBe(2);
    });
  });
});

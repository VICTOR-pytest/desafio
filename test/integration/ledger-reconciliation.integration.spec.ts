import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { GetLedgerUseCase } from '../../src/application/get-ledger.use-case';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { ReconcileAllWalletsUseCase } from '../../src/application/reconcile-all-wallets.use-case';
import { ReconcileWalletUseCase } from '../../src/application/reconcile-wallet.use-case';
import { PostgresReconciliationStore } from '../../src/infrastructure/database/repositories/postgres-reconciliation.repository';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';
import {
  command,
  createTestOrm,
  nextId,
  resetDatabase,
  rows,
  scalar,
} from './support';

describe('ledger paginado e reconciliação (PostgreSQL real)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let open: OpenWalletUseCase;
  let process_: ProcessWagerTransactionUseCase;
  let ledger: GetLedgerUseCase;
  let reconcile: ReconcileWalletUseCase;

  beforeAll(async () => {
    orm = await createTestOrm();
    await resetDatabase(orm);
    em = orm.em as EntityManager;
    const uow = new PostgresUnitOfWork(em);
    open = new OpenWalletUseCase(uow);
    process_ = new ProcessWagerTransactionUseCase(uow);
    ledger = new GetLedgerUseCase(uow);
    reconcile = new ReconcileWalletUseCase(uow);
  });

  afterAll(async () => {
    await orm.close();
  });

  const newWallet = async (balance = '1000.00') => {
    const playerId = nextId('player');
    const wallet = await open.execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: balance, currency: 'BRL' },
    });
    return { playerId, walletId: wallet.walletId };
  };

  const fill = async (playerId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      await process_.execute(command(playerId, i % 2 ? 'WIN' : 'BET', '1.00'));
    }
  };

  describe('ledger', () => {
    it('pagina com cursor opaco e devolve todos os lançamentos sem repetição, em ordem', async () => {
      const { playerId, walletId } = await newWallet();
      await fill(playerId, 24);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const page = await ledger.execute(walletId, cursor, 10);
        seen.push(...page.items.map((item) => item.sequence));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      const numeric = seen.map(BigInt);
      expect(numeric).toEqual([...numeric].sort((a, b) => (a < b ? -1 : 1)));
    });

    it('o primeiro item é o OPENING e o cursor não expõe a estrutura interna', async () => {
      const { playerId, walletId } = await newWallet();
      await fill(playerId, 3);

      const page = await ledger.execute(walletId, null, 2);

      expect(page.items[0]).toMatchObject({ type: 'OPENING', direction: 'CREDIT' });
      expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(page.nextCursor).not.toMatch(/^\d+$/);
    });

    it('o cursor é estável: lançamentos novos não alteram nem repetem páginas já lidas', async () => {
      const { playerId, walletId } = await newWallet();
      await fill(playerId, 9);

      const first = await ledger.execute(walletId, null, 5);
      await fill(playerId, 6);
      const second = await ledger.execute(walletId, first.nextCursor, 5);
      const third = await ledger.execute(walletId, second.nextCursor, 50);
      const all = [...first.items, ...second.items, ...third.items];

      expect(all).toHaveLength(16);
      expect(new Set(all.map((item) => item.entryId)).size).toBe(16);
      expect(third.nextCursor).toBeNull();
    });

    it('mostra saldo anterior e posterior coerentes com o valor', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await process_.execute(command(playerId, 'BET', '30.00'));

      const { items } = await ledger.execute(walletId, null, 10);

      expect(items[1]).toMatchObject({
        type: 'BET',
        direction: 'DEBIT',
        amount: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
      });
    });

    it('valida cursor, limite e carteira', async () => {
      const { walletId } = await newWallet();

      await expect(ledger.execute(walletId, 'invalido', 10)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
      await expect(
        ledger.execute(walletId, Buffer.from('{"v":2,"s":"1"}').toString('base64url'), 10),
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
      await expect(ledger.execute(walletId, null, 0)).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
      await expect(ledger.execute(walletId, null, 201)).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
      await expect(
        ledger.execute('00000000-0000-0000-0000-000000000000', null, 10),
      ).rejects.toMatchObject({ name: 'WalletIdNotFoundError' });
      await expect(ledger.execute('nao-e-uuid', null, 10)).rejects.toMatchObject({
        name: 'WalletIdNotFoundError',
      });
    });

    it('é imutável: o banco recusa alterar ou apagar lançamentos pelo cursor lido', async () => {
      const { walletId } = await newWallet();
      const { items } = await ledger.execute(walletId, null, 1);

      await expect(
        em.execute(`delete from wallet_ledger_entries where id = ?`, [items[0].entryId], 'run'),
      ).rejects.toThrow('imutável');
    });
  });

  describe('reconciliação', () => {
    it('confirma consistência e não registra divergência', async () => {
      const { playerId, walletId } = await newWallet('100.00');
      await fill(playerId, 6);

      const result = await reconcile.execute(walletId);

      expect(result).toMatchObject({
        walletId,
        status: 'CONSISTENT',
        discrepancyId: null,
        difference: { amount: '0.00' },
      });
      expect(result.materializedBalance).toEqual(result.ledgerBalance);
      expect(
        await scalar(em, `select count(*) from reconciliation_discrepancies where wallet_id = ?`, [walletId]),
      ).toBe('0');
    });

    it('detecta divergência, registra e nunca corrige o saldo silenciosamente', async () => {
      const { walletId } = await newWallet('100.00');
      await em.execute(`update wallets set balance_in_cents = balance_in_cents + 5 where id = ?`, [walletId], 'run');

      const result = await reconcile.execute(walletId);

      expect(result).toMatchObject({
        status: 'DISCREPANCY',
        materializedBalance: { amount: '100.05' },
        ledgerBalance: { amount: '100.00' },
        difference: { amount: '0.05' },
      });
      expect(result.discrepancyId).not.toBeNull();
      expect(await scalar(em, `select balance_in_cents::text from wallets where id = ?`, [walletId])).toBe('10005');

      const [row] = await rows(
        em,
        `select materialized_balance_in_cents::text m, ledger_balance_in_cents::text l,
                difference_in_cents::text d, source from reconciliation_discrepancies where id = ?`,
        [result.discrepancyId],
      );
      expect(row).toEqual({ m: '10005', l: '10000', d: '5', source: 'MANUAL' });
    });

    it('divergência repetida não duplica o registro e uma nova gera outro', async () => {
      const { walletId } = await newWallet('100.00');
      await em.execute(`update wallets set balance_in_cents = balance_in_cents - 7 where id = ?`, [walletId], 'run');

      const first = await reconcile.execute(walletId);
      const second = await reconcile.execute(walletId);
      await em.execute(`update wallets set balance_in_cents = balance_in_cents - 1 where id = ?`, [walletId], 'run');
      const third = await reconcile.execute(walletId);

      expect(second.discrepancyId).toBe(first.discrepancyId);
      expect(third.discrepancyId).not.toBe(first.discrepancyId);
      expect(third.difference.amount).toBe('-0.08');
      expect(
        await scalar(em, `select count(*) from reconciliation_discrepancies where wallet_id = ?`, [walletId]),
      ).toBe('2');
    });

    it('retorna 404 lógico para carteira inexistente', async () => {
      await expect(
        reconcile.execute('00000000-0000-0000-0000-000000000000'),
      ).rejects.toMatchObject({ name: 'WalletIdNotFoundError' });
    });

    it('a reconciliação periódica verifica todas as carteiras e registra as divergências', async () => {
      const a = await newWallet('10.00');
      const b = await newWallet('20.00');
      await em.execute(`update wallets set balance_in_cents = 1 where id = ?`, [b.walletId], 'run');

      const summary = await new ReconcileAllWalletsUseCase(
        new PostgresReconciliationStore(em),
        reconcile,
      ).runOnce();

      expect(summary.failures).toBe(0);
      expect(summary.checked).toBeGreaterThanOrEqual(2);
      expect(summary.discrepancies).toBeGreaterThanOrEqual(1);
      expect(
        await scalar(
          em,
          `select count(*) from reconciliation_discrepancies where wallet_id = ? and source = 'SCHEDULED'`,
          [b.walletId],
        ),
      ).toBe('1');
      expect(
        await scalar(em, `select count(*) from reconciliation_discrepancies where wallet_id = ?`, [a.walletId]),
      ).toBe('0');
    });

    it('após operações concorrentes, o saldo materializado = saldo reconstruído pelo ledger', async () => {
      const { playerId, walletId } = await newWallet('500.00');

      await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          process_.execute(command(playerId, i % 3 === 0 ? 'WIN' : 'BET', '3.33')),
        ),
      );

      expect((await reconcile.execute(walletId)).status).toBe('CONSISTENT');
    });
  });
});

import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import {
  PendingReferenceWorkerOptions,
  ResolvePendingReferencesUseCase,
} from '../../src/application/resolve-pending-references.use-case';
import { WagerProcessor } from '../../src/domain/wager-processor/wager-processor';
import { PostgresPendingReferenceStore } from '../../src/infrastructure/database/repositories/postgres-pending-reference.store';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';
import {
  clearData,
  command,
  createTestOrm,
  ledgerNet,
  nextId,
  resetDatabase,
  rows,
  scalar,
} from './support';
import type { EntityManager } from '@mikro-orm/postgresql';

describe('referências pendentes (PostgreSQL real)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let now: Date;
  let uow: PostgresUnitOfWork;
  let open: OpenWalletUseCase;
  let process_: ProcessWagerTransactionUseCase;

  const clock = () => now;
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  const resolver = (options: Partial<PendingReferenceWorkerOptions> = {}) =>
    new ResolvePendingReferencesUseCase(
      new PostgresPendingReferenceStore(em),
      uow,
      new WagerProcessor(),
      { baseBackoffMs: 1000, maxBackoffMs: 60_000, ...options },
      clock,
    );

  beforeAll(async () => {
    orm = await createTestOrm();
    await resetDatabase(orm);
    em = orm.em as EntityManager;
    uow = new PostgresUnitOfWork(em);
    open = new OpenWalletUseCase(uow);
  });

  beforeEach(async () => {
    await clearData(orm);
    now = new Date();
    process_ = new ProcessWagerTransactionUseCase(
      uow,
      new WagerProcessor(),
      clock,
      undefined,
      { ttlMs: 60_000, baseBackoffMs: 1000 },
    );
  });

  afterAll(async () => {
    await orm.close();
  });

  const newWallet = async (balance = '100.00') => {
    const playerId = nextId('player');
    const wallet = await open.execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: balance, currency: 'BRL' },
    });
    return { playerId, walletId: wallet.walletId };
  };

  const eventsFor = async (transactionId: string) =>
    (
      await rows(
        em,
        `select event_type from outbox_messages
         where aggregate_id = ? or payload->>'transactionId' = ? order by event_type`,
        [transactionId, transactionId],
      )
    ).map((row) => row.event_type as string);

  const stateOf = async (transactionId: string) =>
    (
      await rows(
        em,
        `select status, failure_code, pending_attempts from wager_transactions where id = ?`,
        [transactionId],
      )
    )[0];

  const balanceOf = async (walletId: string) =>
    scalar(em, `select balance_in_cents::text from wallets where id = ?`, [walletId]);

  it('REFUND recebido antes da BET fica pendente e só emite o evento de pendência', async () => {
    const { playerId } = await newWallet();
    const bet = command(playerId, 'BET', '10.00');
    const refund = command(playerId, 'REFUND', '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const result = await process_.execute(refund);

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(await eventsFor(result.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });

  it('não reprocessa antes do backoff e mantém pendente enquanto a referência não existe', async () => {
    const { playerId } = await newWallet();
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', { referenceExternalTransactionId: 'nao-chegou' }),
    );

    expect(await resolver().runOnce()).toMatchObject({ skipped: 0, stillPending: 0 });

    advance(1500);
    expect(await resolver().runOnce()).toMatchObject({ stillPending: 1 });
    expect((await stateOf(refund.transactionId)).pending_attempts).toBe(1);
    expect((await stateOf(refund.transactionId)).status).toBe('PENDING_REFERENCE');

    advance(1500);
    expect(await resolver().runOnce()).toMatchObject({ stillPending: 0 });
    advance(5000);
    expect(await resolver().runOnce()).toMatchObject({ stillPending: 1 });
    expect(await eventsFor(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });

  it('resolve o REFUND quando a BET chega, sem duplicar saldo, ledger ou eventos', async () => {
    const { playerId, walletId } = await newWallet('100.00');
    const bet = command(playerId, 'BET', '10.00');
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        correlationId: 'corr-1',
      }),
    );
    await process_.execute(bet);
    expect(await balanceOf(walletId)).toBe('9000');

    advance(2000);
    const first = await resolver().runOnce();
    advance(120_000);
    const second = await resolver().runOnce();

    expect(first).toMatchObject({ processed: 1 });
    expect(second).toEqual({ processed: 0, rejected: 0, stillPending: 0, expired: 0, skipped: 0 });
    expect(await stateOf(refund.transactionId)).toMatchObject({ status: 'PROCESSED', failure_code: null });
    expect(await balanceOf(walletId)).toBe('10000');
    expect(await ledgerNet(em, walletId)).toBe('10000');
    expect(await scalar(em, `select version from wallets where id = ?`, [walletId])).toBe('3');
    expect(await eventsFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(
      await scalar(em, `select count(*) from wallet_ledger_entries where transaction_id = ?`, [refund.transactionId]),
    ).toBe('1');
    expect(
      await scalar(
        em,
        `select count(distinct correlation_id) from outbox_messages where aggregate_id = ? or payload->>'transactionId' = ?`,
        [refund.transactionId, refund.transactionId],
      ),
    ).toBe('1');
  });

  it('resolve um ROLLBACK de WIN recebido antes da WIN', async () => {
    const { playerId, walletId } = await newWallet('50.00');
    const win = command(playerId, 'WIN', '20.00');
    await process_.execute(
      command(playerId, 'ROLLBACK', '20.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    await process_.execute(win);

    advance(2000);
    await resolver().runOnce();

    expect(await balanceOf(walletId)).toBe('5000');
  });

  it('rejeita com o código da regra quando a referência chega divergente', async () => {
    const { playerId, walletId } = await newWallet('100.00');
    const bet = command(playerId, 'BET', '10.00', { roundId: 'round-A' });
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', {
        roundId: 'round-B',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await process_.execute(bet);

    advance(2000);
    const summary = await resolver().runOnce();

    expect(summary.rejected).toBe(1);
    expect(await stateOf(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'ROUND_MISMATCH',
    });
    expect(await balanceOf(walletId)).toBe('9000');
    expect(await eventsFor(refund.transactionId)).toContain('WagerTransactionRejected');
  });

  it('expira após o TTL para REJECTED com código estável e evento', async () => {
    const { playerId, walletId } = await newWallet('100.00');
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', { referenceExternalTransactionId: 'nunca-chega' }),
    );

    advance(61_000);
    const summary = await resolver().runOnce();
    advance(61_000);
    const again = await resolver().runOnce();

    expect(summary.expired).toBe(1);
    expect(again.expired).toBe(0);
    expect(await stateOf(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'PENDING_REFERENCE_EXPIRED',
    });
    expect(await balanceOf(walletId)).toBe('10000');
    expect(await scalar(em, `select version from wallets where id = ?`, [walletId])).toBe('1');
    expect(await eventsFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  it('expira ao atingir o número máximo de tentativas', async () => {
    const { playerId } = await newWallet();
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', { referenceExternalTransactionId: 'nunca-chega' }),
    );
    const worker = resolver({ maxAttempts: 2 });

    advance(2000);
    expect((await worker.runOnce()).stillPending).toBe(1);
    advance(10_000);
    expect((await worker.runOnce()).expired).toBe(1);
    expect((await stateOf(refund.transactionId)).failure_code).toBe('PENDING_REFERENCE_EXPIRED');
  });

  it('recupera um item cujo worker morreu após reivindicar (lease expira)', async () => {
    const { playerId } = await newWallet();
    const bet = command(playerId, 'BET', '10.00');
    const refund = await process_.execute(
      command(playerId, 'REFUND', '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await process_.execute(bet);
    advance(2000);

    const store = new PostgresPendingReferenceStore(em);
    const claimed = await store.claimDue({ limit: 10, leaseMs: 30_000, now });
    expect(claimed.map((c) => c.transactionId)).toContain(refund.transactionId);

    expect(await resolver().runOnce()).toMatchObject({ processed: 0 });
    advance(31_000);
    expect(await resolver().runOnce()).toMatchObject({ processed: 1 });
  });

  it('três workers concorrentes resolvem 24 pendentes exatamente uma vez cada', async () => {
    const { playerId, walletId } = await newWallet('1000.00');
    const refunds: string[] = [];
    const bets = [];

    for (let i = 0; i < 24; i++) {
      const bet = command(playerId, 'BET', '5.00');
      bets.push(bet);
      const refund = await process_.execute(
        command(playerId, 'REFUND', '5.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      refunds.push(refund.transactionId);
    }
    for (const bet of bets) await process_.execute(bet);
    advance(2000);

    const summaries = await Promise.all(
      [1, 2, 3].map(() => resolver({ batchSize: 10 }).runOnce()),
    );
    for (let i = 0; i < 4; i++) {
      advance(1000);
      await resolver({ batchSize: 10 }).runOnce();
    }

    const processed = await scalar(
      em,
      `select count(*) from wager_transactions where id = any(?::uuid[]) and status = 'PROCESSED'`,
      [`{${refunds.join(',')}}`],
    );
    expect(processed).toBe('24');
    expect(summaries.reduce((sum, s) => sum + s.processed, 0)).toBeLessThanOrEqual(24);
    expect(
      await scalar(
        em,
        `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'REFUND'`,
        [walletId],
      ),
    ).toBe('24');
    expect(await balanceOf(walletId)).toBe('100000');
    expect(await ledgerNet(em, walletId)).toBe('100000');
    expect(
      await scalar(
        em,
        `select count(*) from outbox_messages where event_type = 'WagerTransactionProcessed' and aggregate_id = any(?::uuid[])`,
        [`{${refunds.join(',')}}`],
      ),
    ).toBe('24');
  });
});

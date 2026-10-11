import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { nextId, scalar } from '../integration/support';
import { createApp } from './support';

describe('três instâncias da aplicação sobre o mesmo PostgreSQL 17 (e2e)', () => {
  let apps: INestApplication[];
  let urls: string[];
  let em: EntityManager;

  beforeAll(async () => {
    const first = await createApp({ resetDb: true });
    const others = await Promise.all([createApp(), createApp()]);

    apps = [first, ...others];
    await Promise.all(apps.map((app) => app.listen(0, '127.0.0.1')));
    urls = await Promise.all(apps.map((app) => app.getUrl()));
    em = first.get(EntityManager);
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  const post = (instance: number, path: string, body: object, key?: string) =>
    fetch(`${urls[instance % 3]}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });

  const open = async (amount = '100.00') => {
    const playerId = nextId('player');
    const response = await post(0, '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    return { playerId, ...((await response.json()) as { walletId: string }) };
  };

  const tx = (playerId: string, amount = '10.00', overrides = {}) => ({
    providerId: 'provider-1',
    externalTransactionId: nextId('ext'),
    playerId,
    roundId: 'r',
    type: 'BET',
    amount: { amount, currency: 'BRL' },
    ...overrides,
  });

  const balance = async (walletId: string) =>
    ((await (await fetch(`${urls[2]}/wallets/${walletId}`)).json()) as {
      balance: { amount: string };
      version: number;
    });

  it('as instâncias são processos de aplicação distintos, com pools distintos', () => {
    expect(new Set(apps.map((app) => app.get(EntityManager))).size).toBe(3);
    expect(new Set(urls).size).toBe(3);
  });

  it('50 submissões idênticas distribuídas entre as instâncias geram um único efeito', async () => {
    const { playerId, walletId } = await open();
    const payload = tx(playerId);
    const key = nextId('key');

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => post(i, '/wagering/transactions', payload, key)),
    );
    const statuses = responses.map((r) => r.status);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      transactionId: string;
    }>;

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
    expect((await balance(walletId)).balance.amount).toBe('90.00');
  });

  it('duas apostas de 80,00 em instâncias diferentes sobre 100,00: uma processada e uma rejeitada', async () => {
    const { playerId, walletId } = await open('100.00');

    const responses = await Promise.all([
      post(0, '/wagering/transactions', tx(playerId, '80.00'), nextId('k')),
      post(1, '/wagering/transactions', tx(playerId, '80.00'), nextId('k')),
    ]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ status: string }>;

    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 422]);
    expect(bodies.map((b) => b.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect((await balance(walletId)).balance.amount).toBe('20.00');
    expect(
      await scalar(em, `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`, [walletId]),
    ).toBe('1');
  });

  it('60 apostas concorrentes na mesma carteira entre as três instâncias respeitam saldo e versão', async () => {
    const { playerId, walletId } = await open('100.00');

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        post(i, '/wagering/transactions', tx(playerId, '5.00'), nextId('k')),
      ),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      status: string;
      wallet: { version: number };
    }>;
    const processed = bodies.filter((b) => b.status === 'PROCESSED');
    const wallet = await balance(walletId);

    expect(processed).toHaveLength(20);
    expect(new Set(processed.map((b) => b.wallet.version)).size).toBe(20);
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.version).toBe(21);
  });

  it('carteiras diferentes são processadas em paralelo nas três instâncias', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => open('100.00')));

    const responses = await Promise.all(
      wallets.flatMap(({ playerId }, i) => [
        post(i, '/wagering/transactions', tx(playerId, '30.00'), nextId('k')),
        post(i + 1, '/wagering/transactions', tx(playerId, '30.00'), nextId('k')),
      ]),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const { walletId } of wallets) {
      expect(await balance(walletId)).toMatchObject({ balance: { amount: '40.00' }, version: 3 });
    }
  });

  it('REFUND/ROLLBACK enviados a instâncias diferentes aplicam uma reversão por tipo', async () => {
    const { playerId, walletId } = await open('100.00');
    const bet = tx(playerId, '40.00');
    await post(0, '/wagering/transactions', bet, nextId('k'));
    const reversal = (type: string, i: number) =>
      post(i, '/wagering/transactions', tx(playerId, '40.00', {
        type,
        referenceExternalTransactionId: bet.externalTransactionId,
      }), nextId('k'));

    const responses = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => reversal(i % 2 ? 'ROLLBACK' : 'REFUND', i)),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ status: string }>;

    expect(bodies.filter((b) => b.status === 'PROCESSED')).toHaveLength(2);
    expect((await balance(walletId)).balance.amount).toBe('140.00');
  });

  it('ao final, todo saldo materializado é igual ao reconstruído pelo ledger', async () => {
    const mismatched = await scalar(
      em,
      `select count(*) from wallets w where w.balance_in_cents <>
         (select coalesce(sum(case direction when 'CREDIT' then amount_in_cents else -amount_in_cents end), 0)
          from wallet_ledger_entries where wallet_id = w.id)`,
    );
    const versionMismatch = await scalar(
      em,
      `select count(*) from wallets w where w.version <>
         1 + (select count(*) from wallet_ledger_entries where wallet_id = w.id and entry_type <> 'OPENING')`,
    );

    expect(mismatched).toBe('0');
    expect(versionMismatch).toBe('0');
    expect(await scalar(em, `select count(*) from wallets where balance_in_cents < 0`)).toBe('0');
  });
});

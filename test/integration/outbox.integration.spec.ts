import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { ClaimedOutboxMessage, EventPublisher } from '../../src/application/ports';
import { PostgresOutboxStore } from '../../src/infrastructure/database/repositories/postgres-outbox.repository';
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

class RecordingPublisher implements EventPublisher {
  readonly published: ClaimedOutboxMessage[] = [];
  failFor = new Set<string>();
  delayMs = 0;

  async publish(message: ClaimedOutboxMessage): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failFor.has(message.id)) throw new Error('broker indisponível');
    this.published.push(message);
  }
}

describe('outbox (PostgreSQL real)', () => {
  let orm: MikroORM;
  let h: Harness;
  let store: PostgresOutboxStore;

  beforeAll(async () => {
    orm = await createTestOrm();
    await resetDatabase(orm);
    h = buildHarness(orm);
    store = new PostgresOutboxStore(h.em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await h.em.execute(`update outbox_messages set status = 'PUBLISHED', published_at = now(), locked_until = null`, [], 'run');
  });

  const seed = async (bets = 3) => {
    const playerId = nextId('p');
    await h.openWallet.execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: '1000.00', currency: 'BRL' },
    });
    for (let i = 0; i < bets; i++) {
      await h.process.execute(command(playerId, 'BET', '1.00'));
    }
    return playerId;
  };

  const pendingIds = async () =>
    (await rows(h.em, `select id from outbox_messages where status = 'PENDING' order by created_at, id`)).map(
      (r) => r.id as string,
    );

  const keepOnly = (id: string) =>
    h.em.execute(
      `update outbox_messages set status = 'PUBLISHED', published_at = now() where status = 'PENDING' and id <> ?`,
      [id],
      'run',
    );

  it('só enxerga eventos confirmados: transação revertida não deixa evento', async () => {
    const before = await scalar(h.em, `select count(*) from outbox_messages`);
    const playerId = nextId('ghost');

    await h.process.execute({ ...command(playerId, 'BET', '1.00'), amount: { amount: '1.00', currency: 'BRL' } });
    await expect(
      h.process.execute(command(playerId, 'BET', '1.5')),
    ).rejects.toBeDefined();

    expect(Number(await scalar(h.em, `select count(*) from outbox_messages`)) - Number(before)).toBe(1);
  });

  it('publica os eventos pendentes em ordem e os marca como PUBLISHED', async () => {
    await seed(3);
    const expected = await pendingIds();
    const publisher = new RecordingPublisher();

    const summary = await new OutboxPublisher(store, publisher).publishPending();

    expect(summary).toEqual({ published: expected.length, failed: 0 });
    expect(publisher.published.map((m) => m.id)).toEqual(expected);
    expect(await pendingIds()).toEqual([]);
    expect(
      await scalar(h.em, `select count(*) from outbox_messages where status = 'PUBLISHED' and published_at is null`),
    ).toBe('0');
  });

  it('falha de publicação aplica backoff exponencial e mantém o evento pendente', async () => {
    await seed(1);
    const [id] = await pendingIds();
    await keepOnly(id);
    const publisher = new RecordingPublisher();
    publisher.failFor.add(id);
    let now = new Date();
    const outbox = new OutboxPublisher(
      store,
      publisher,
      { baseBackoffMs: 1000, batchSize: 1 },
      () => now,
    );

    expect((await outbox.publishPending()).failed).toBe(1);
    let [row] = await rows(h.em, `select attempts, status, last_error, extract(epoch from next_attempt_at) n from outbox_messages where id = ?`, [id]);
    expect(row).toMatchObject({ attempts: 1, status: 'PENDING', last_error: 'broker indisponível' });
    const firstDue = Number(row.n);
    expect(firstDue).toBeGreaterThan(now.getTime() / 1000);

    expect(await outbox.publishPending()).toEqual({ published: 0, failed: 0 });

    now = new Date(now.getTime() + 1500);
    expect((await outbox.publishPending()).failed).toBe(1);
    [row] = await rows(h.em, `select attempts, extract(epoch from next_attempt_at) n from outbox_messages where id = ?`, [id]);
    expect(row.attempts).toBe(2);
    expect(Number(row.n) - now.getTime() / 1000).toBeGreaterThan(1.9);

    publisher.failFor.clear();
    now = new Date(now.getTime() + 10_000);
    expect((await outbox.publishPending()).published).toBe(1);
    expect(await scalar(h.em, `select status from outbox_messages where id = ?`, [id])).toBe('PUBLISHED');
  });

  it('desiste após o máximo de tentativas marcando FAILED', async () => {
    await seed(1);
    const [id] = await pendingIds();
    await keepOnly(id);
    const publisher = new RecordingPublisher();
    publisher.failFor.add(id);
    let now = new Date();
    const outbox = new OutboxPublisher(
      store,
      publisher,
      { maxAttempts: 2, baseBackoffMs: 10, batchSize: 1 },
      () => now,
    );

    await outbox.publishPending();
    now = new Date(now.getTime() + 60_000);
    await outbox.publishPending();

    expect(await scalar(h.em, `select status from outbox_messages where id = ?`, [id])).toBe('FAILED');
    now = new Date(now.getTime() + 600_000);
    expect(await outbox.publishPending()).toEqual({ published: 0, failed: 0 });
  });

  it('dois publicadores concorrentes nunca publicam o mesmo evento', async () => {
    await seed(20);
    const total = (await pendingIds()).length;
    const first = new RecordingPublisher();
    const second = new RecordingPublisher();
    first.delayMs = second.delayMs = 5;

    await Promise.all([
      new OutboxPublisher(store, first, { batchSize: 10 }).publishPending(),
      new OutboxPublisher(new PostgresOutboxStore(h.em), second, { batchSize: 10 }).publishPending(),
      new OutboxPublisher(new PostgresOutboxStore(h.em), second, { batchSize: 10 }).publishPending(),
    ]);

    const ids = [...first.published, ...second.published].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(Math.min(total, 30));
  });

  it('recupera eventos de um publicador que caiu após o fim do lease', async () => {
    await seed(1);
    const [id] = await pendingIds();
    const start = new Date();

    const claimed = await store.claimBatch({ limit: 10, leaseMs: 5000, now: start });
    expect(claimed.map((m) => m.id)).toContain(id);

    expect(await store.claimBatch({ limit: 10, leaseMs: 5000, now: new Date(start.getTime() + 1000) })).toEqual([]);

    const recovered = await store.claimBatch({
      limit: 10,
      leaseMs: 5000,
      now: new Date(start.getTime() + 6000),
    });
    expect(recovered.map((m) => m.id)).toContain(id);
    expect(recovered.find((m) => m.id === id)?.attempts).toBe(2);
  });
});

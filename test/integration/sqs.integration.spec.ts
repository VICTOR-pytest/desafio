import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { TransactionalContext, UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';
import { PostgresOutboxStore } from '../../src/infrastructure/database/repositories/postgres-outbox.repository';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import {
  ConsumerHooks,
  SqsWagerConsumer,
} from '../../src/infrastructure/sqs/sqs-wager-consumer';
import { WAGER_CONSUMER_NAME } from '../../src/infrastructure/sqs/sqs-message-parser';
import { createTestOrm, nextId, resetDatabase, rows, scalar } from './support';
import {
  createTestQueues,
  isEmpty,
  queueDepth,
  receiveAll,
  sendWager,
  TestQueues,
  waitFor,
} from './sqs-support';

class FlakyUnitOfWork implements UnitOfWork {
  attempts = 0;

  constructor(
    private readonly inner: UnitOfWork,
    private readonly failures: number,
  ) {}

  run<T>(work: (context: TransactionalContext) => Promise<T>): Promise<T> {
    this.attempts++;

    if (this.attempts <= this.failures) {
      return Promise.reject(new Error('banco indisponível'));
    }

    return this.inner.run(work);
  }
}

describe('SQS FIFO + PostgreSQL (LocalStack real)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let uow: PostgresUnitOfWork;
  let queues: TestQueues;
  let metrics: MetricsRegistry;
  const silent = new JsonLogger(() => undefined);

  const telemetry = () => ({ metrics, logger: silent });
  const useCase = (unitOfWork: UnitOfWork = uow) =>
    new ProcessWagerTransactionUseCase(
      unitOfWork,
      undefined,
      undefined,
      telemetry(),
    );
  const consumerFor = (
    process: ProcessWagerTransactionUseCase,
    hooks: ConsumerHooks = {},
  ) =>
    new SqsWagerConsumer(
      queues.client,
      queues.urls.wagerQueueUrl,
      queues.urls.wagerDlqUrl,
      process,
      { waitTimeSeconds: 1, retryBaseSeconds: 1, retryMaxSeconds: 4 },
      telemetry(),
      hooks,
    );

  const pollUntil = async (
    consumer: SqsWagerConsumer,
    condition: () => Promise<boolean>,
    timeoutMs = 25_000,
  ) => {
    await waitFor(async () => {
      await consumer.pollOnce();
      return condition();
    }, timeoutMs, 0);
  };

  beforeAll(async () => {
    orm = await createTestOrm();
    await resetDatabase(orm);
    em = orm.em as EntityManager;
    uow = new PostgresUnitOfWork(em);
  });

  beforeEach(async () => {
    metrics = new MetricsRegistry();
    queues = await createTestQueues();
  });

  afterAll(async () => {
    await orm.close();
  });

  const wallet = async (balance = '100.00') => {
    const playerId = nextId('player');
    const opened = await new OpenWalletUseCase(uow).execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: balance, currency: 'BRL' },
    });
    return { playerId, walletId: opened.walletId };
  };

  const message = (playerId: string, overrides: Record<string, unknown> = {}) => ({
    providerId: 'provider-q',
    externalTransactionId: nextId('ext'),
    playerId,
    roundId: 'round-1',
    type: 'BET',
    amount: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  });

  const balance = async (walletId: string) =>
    scalar(em, `select balance_in_cents::text from wallets where id = ?`, [walletId]);
  const txCount = async (externalId: string) =>
    Number(
      await scalar(em, `select count(*) from wager_transactions where external_transaction_id = ?`, [
        externalId,
      ]),
    );
  const inboxRows = (messageId: string) =>
    rows(
      em,
      `select source, transaction_id, processed_at is not null as done from inbox_messages where message_id = ?`,
      [messageId],
    );

  it('processa a mensagem com a mesma regra do HTTP e só confirma depois do commit', async () => {
    const { playerId, walletId } = await wallet('100.00');
    const payload = message(playerId, { correlationId: 'corr-sqs-1' });
    const messageId = await sendWager(queues, payload);
    let seenBeforeAck = '';
    const consumer = consumerFor(useCase(), {
      beforeAcknowledge: async () => {
        seenBeforeAck = await balance(walletId);
      },
    });

    await pollUntil(consumer, async () => (await balance(walletId)) === '9000');
    await waitFor(() => isEmpty(queues.client, queues.urls.wagerQueueUrl));

    expect(seenBeforeAck).toBe('9000');
    expect(await inboxRows(messageId)).toEqual([
      { source: WAGER_CONSUMER_NAME, transaction_id: expect.any(String), done: true },
    ]);
    expect(await isEmpty(queues.client, queues.urls.wagerDlqUrl)).toBe(true);
    expect(
      await scalar(
        em,
        `select count(*) from outbox_messages where correlation_id = 'corr-sqs-1' and causation_id = ?`,
        [messageId],
      ),
    ).toBe('2');
    expect(metrics.counter('sqs_messages_total', { result: 'processed' })).toBe(1);
  });

  it('rejeição de negócio é terminal: persiste REJECTED, confirma e não vai para a DLQ', async () => {
    const { playerId, walletId } = await wallet('5.00');
    const payload = message(playerId, { amount: { amount: '50.00', currency: 'BRL' } });
    await sendWager(queues, payload);
    const consumer = consumerFor(useCase());

    await pollUntil(consumer, async () => (await txCount(payload.externalTransactionId)) === 1);
    await waitFor(() => isEmpty(queues.client, queues.urls.wagerQueueUrl));

    expect(
      await scalar(em, `select status||':'||failure_code from wager_transactions where external_transaction_id = ?`, [
        payload.externalTransactionId,
      ]),
    ).toBe('REJECTED:INSUFFICIENT_FUNDS');
    expect(await balance(walletId)).toBe('500');
    expect(await isEmpty(queues.client, queues.urls.wagerDlqUrl)).toBe(true);
  });

  it('mensagens duplicadas (MessageIds diferentes) geram um único efeito financeiro', async () => {
    const { playerId, walletId } = await wallet('100.00');
    const payload = message(playerId);
    const first = await sendWager(queues, payload);
    const second = await sendWager(queues, payload);
    const consumer = consumerFor(useCase());

    await pollUntil(
      consumer,
      async () => (await inboxRows(first)).length === 1 && (await inboxRows(second)).length === 1,
    );
    await waitFor(() => isEmpty(queues.client, queues.urls.wagerQueueUrl));

    expect(first).not.toBe(second);
    expect(await balance(walletId)).toBe('9000');
    expect(await txCount(payload.externalTransactionId)).toBe(1);
    expect(
      await scalar(em, `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`, [walletId]),
    ).toBe('1');
    const links = await rows(em, `select distinct transaction_id from inbox_messages where message_id = any(?::text[])`, [
      `{${first},${second}}`,
    ]);
    expect(links).toHaveLength(1);
    expect(metrics.counter('sqs_messages_total', { result: 'duplicate' })).toBe(1);
  });

  it('o SQS FIFO descarta o reenvio com o mesmo MessageDeduplicationId', async () => {
    const { playerId } = await wallet();
    const payload = message(playerId);
    await sendWager(queues, payload, { dedupId: 'mesmo-id' });
    await sendWager(queues, payload, { dedupId: 'mesmo-id' });

    const received = await receiveAll(queues.client, queues.urls.wagerQueueUrl, 1);
    const depth = await queueDepth(queues.client, queues.urls.wagerQueueUrl);

    expect(received).toHaveLength(1);
    expect(depth).toEqual({ visible: 0, inFlight: 1, delayed: 0 });
  });

  it('worker morto após o commit e antes do ack: a mensagem volta e não duplica efeitos', async () => {
    const { playerId, walletId } = await wallet('100.00');
    const payload = message(playerId);
    const messageId = await sendWager(queues, payload);
    const crashing = consumerFor(useCase(), {
      beforeAcknowledge: async () => {
        throw new Error('processo morreu antes do ack');
      },
    });

    await pollUntil(crashing, async () => (await txCount(payload.externalTransactionId)) === 1);

    expect(await balance(walletId)).toBe('9000');
    expect((await inboxRows(messageId))[0].done).toBe(true);
    expect(await isEmpty(queues.client, queues.urls.wagerQueueUrl)).toBe(false);

    const survivor = consumerFor(useCase());
    await pollUntil(survivor, () => isEmpty(queues.client, queues.urls.wagerQueueUrl));

    expect(await balance(walletId)).toBe('9000');
    expect(await txCount(payload.externalTransactionId)).toBe(1);
    expect(await inboxRows(messageId)).toHaveLength(1);
    expect(await isEmpty(queues.client, queues.urls.wagerDlqUrl)).toBe(true);
    expect(metrics.counter('sqs_messages_total', { result: 'duplicate' })).toBe(1);
  });

  describe('falhas permanentes vão para a DLQ sem retry', () => {
    const permanent: Array<[string, (player: string) => { payload: Record<string, unknown>; options?: object }, string]> = [
      ['JSON inválido', (p) => ({ payload: { playerId: p }, options: { rawBody: '{quebrado', attributeProvider: 'provider-q' } }), 'INVALID_JSON'],
      ['atributo providerId ausente', (p) => ({ payload: message(p), options: { attributeProvider: null } }), 'PROVIDER_ATTRIBUTE_MISSING'],
      ['providerId do corpo diferente do atributo', (p) => ({ payload: message(p), options: { attributeProvider: 'outro-provedor' } }), 'PROVIDER_IDENTITY_MISMATCH'],
      ['campo desconhecido', (p) => ({ payload: message(p, { extra: 1 }) }), 'INVALID_MESSAGE'],
      ['valor numérico', (p) => ({ payload: message(p, { amount: 10.5 }) }), 'INVALID_MESSAGE'],
      ['escala de valor inválida', (p) => ({ payload: message(p, { amount: { amount: '10.5', currency: 'BRL' } }) }), 'INVALID_AMOUNT'],
      ['OPENING externo', (p) => ({ payload: message(p, { type: 'OPENING' }) }), 'INVALID_TRANSACTION_TYPE'],
    ];

    it.each(permanent)('%s', async (_, build, reason) => {
      const { playerId, walletId } = await wallet('100.00');
      const { payload, options } = build(playerId);
      await sendWager(queues, payload, options);
      const consumer = consumerFor(useCase());

      await pollUntil(consumer, async () => !(await isEmpty(queues.client, queues.urls.wagerDlqUrl)));
      const [dead] = await receiveAll(queues.client, queues.urls.wagerDlqUrl, 1);

      expect(dead.MessageAttributes?.failureReason?.StringValue).toBe(reason);
      expect(await isEmpty(queues.client, queues.urls.wagerQueueUrl)).toBe(true);
      expect(await balance(walletId)).toBe('10000');
      expect(metrics.counter('sqs_dlq_total', { reason })).toBe(1);
    });

    it('conflito de idempotência (mesma identidade, valor diferente) vai para a DLQ', async () => {
      const { playerId, walletId } = await wallet('100.00');
      const original = message(playerId);
      await sendWager(queues, original);
      const consumer = consumerFor(useCase());
      await pollUntil(consumer, async () => (await txCount(original.externalTransactionId)) === 1);

      await sendWager(queues, { ...original, amount: { amount: '99.00', currency: 'BRL' } });
      await pollUntil(consumer, async () => !(await isEmpty(queues.client, queues.urls.wagerDlqUrl)));
      const [dead] = await receiveAll(queues.client, queues.urls.wagerDlqUrl, 1);

      expect(dead.MessageAttributes?.failureReason?.StringValue).toBe('IDEMPOTENCY_CONFLICT');
      expect(await balance(walletId)).toBe('9000');
    });
  });

  it('falha transitória é repetida com backoff e processada uma única vez', async () => {
    const { playerId, walletId } = await wallet('100.00');
    const payload = message(playerId);
    await sendWager(queues, payload);
    const flaky = new FlakyUnitOfWork(uow, 2);
    const consumer = consumerFor(useCase(flaky));
    const startedAt = Date.now();

    await pollUntil(consumer, async () => (await txCount(payload.externalTransactionId)) === 1);
    await waitFor(() => isEmpty(queues.client, queues.urls.wagerQueueUrl));

    expect(flaky.attempts).toBe(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
    expect(await balance(walletId)).toBe('9000');
    expect(metrics.counter('sqs_retries_total')).toBe(2);
    expect(await isEmpty(queues.client, queues.urls.wagerDlqUrl)).toBe(true);
  });

  it('tentativas esgotadas: o SQS redireciona para a DLQ e nada é aplicado', async () => {
    const { playerId, walletId } = await wallet('100.00');
    const payload = message(playerId);
    const messageId = await sendWager(queues, payload);
    const broken = new FlakyUnitOfWork(uow, Number.MAX_SAFE_INTEGER);
    const consumer = consumerFor(useCase(broken));

    await waitFor(async () => {
      await consumer.pollOnce();
      return !(await isEmpty(queues.client, queues.urls.wagerDlqUrl));
    }, 40_000, 0);

    const [dead] = await receiveAll(queues.client, queues.urls.wagerDlqUrl, 1);
    expect(dead.Body).toContain(payload.externalTransactionId);
    expect(broken.attempts).toBeGreaterThanOrEqual(queues.settings.maxReceiveCount);
    expect(await isEmpty(queues.client, queues.urls.wagerQueueUrl)).toBe(true);
    expect(await balance(walletId)).toBe('10000');
    expect(await txCount(payload.externalTransactionId)).toBe(0);
    expect(await inboxRows(messageId)).toEqual([]);
  });

  describe('encerramento gracioso', () => {
    it('stop() conclui a mensagem em andamento, confirma e para de consumir', async () => {
      const { playerId, walletId } = await wallet('100.00');
      let entered = false;
      let finished = false;
      const consumer = consumerFor(useCase(), {
        beforeAcknowledge: async () => {
          entered = true;
          await new Promise((resolve) => setTimeout(resolve, 700));
          finished = true;
        },
      });
      consumer.start();
      await sendWager(queues, message(playerId));
      await waitFor(async () => entered);

      await consumer.stop();

      expect(finished).toBe(true);
      expect(await balance(walletId)).toBe('9000');
      expect(await isEmpty(queues.client, queues.urls.wagerQueueUrl)).toBe(true);

      const late = message(playerId);
      await sendWager(queues, late);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(await txCount(late.externalTransactionId)).toBe(0);
      expect(await isEmpty(queues.client, queues.urls.wagerQueueUrl)).toBe(false);
    });

    it('stop() interrompe a espera longa rapidamente quando não há mensagens', async () => {
      const consumer = new SqsWagerConsumer(
        queues.client,
        queues.urls.wagerQueueUrl,
        queues.urls.wagerDlqUrl,
        useCase(),
        { waitTimeSeconds: 10 },
        telemetry(),
      );
      consumer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const startedAt = Date.now();

      await consumer.stop();

      expect(Date.now() - startedAt).toBeLessThan(2000);
    });
  });

  it('três consumidores concorrentes processam 36 mensagens de 12 carteiras exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => wallet('100.00')));
    const sent: string[] = [];

    for (const { playerId } of wallets) {
      for (let i = 0; i < 3; i++) {
        const payload = message(playerId, { amount: { amount: '5.00', currency: 'BRL' } });
        sent.push(payload.externalTransactionId);
        await sendWager(queues, payload);
      }
    }

    const consumers = [1, 2, 3].map(() => consumerFor(useCase()));
    consumers.forEach((consumer) => consumer.start());
    await waitFor(async () => {
      const done = await scalar(
        em,
        `select count(*) from wager_transactions where external_transaction_id = any(?::text[])`,
        [`{${sent.join(',')}}`],
      );
      return Number(done) === 36;
    }, 40_000);
    await waitFor(() => isEmpty(queues.client, queues.urls.wagerQueueUrl), 20_000);
    await Promise.all(consumers.map((consumer) => consumer.stop()));

    for (const { walletId } of wallets) {
      expect(await balance(walletId)).toBe('8500');
      expect(
        await scalar(em, `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`, [walletId]),
      ).toBe('3');
    }
    expect(await isEmpty(queues.client, queues.urls.wagerDlqUrl)).toBe(true);
  });

  describe('Outbox → SQS', () => {
    const collectEvents = async (count: number) =>
      (await receiveAll(queues.client, queues.urls.eventsQueueUrl, count, 15_000, true)).map((m) => JSON.parse(m.Body ?? '{}'));

    const pendingEvents = async () =>
      Number(await scalar(em, `select count(*) from outbox_messages where status = 'PENDING'`));

    beforeEach(async () => {
      await em.execute(`update outbox_messages set status = 'PUBLISHED', published_at = now()`, [], 'run');
    });

    it('publica o envelope IntegrationEvent completo somente depois do commit', async () => {
      const { playerId, walletId } = await wallet('100.00');
      const bet = await useCase().execute({
        idempotencyKey: nextId('k'),
        provider: 'provider-q',
        externalTransactionId: nextId('ext'),
        playerId,
        roundId: 'r',
        type: 'BET',
        amount: { amount: '10.00', currency: 'BRL' },
        correlationId: 'corr-evt',
        causationId: 'cause-1',
      });
      const publisher = new OutboxPublisher(
        new PostgresOutboxStore(em),
        new SqsEventPublisher(queues.client, queues.urls.eventsQueueUrl),
      );

      const summary = await publisher.publishPending();
      const events = await collectEvents(3);
      const byType = Object.fromEntries(events.map((e) => [e.eventType, e]));

      expect(summary.published).toBe(3);
      expect(Object.keys(byType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ].filter((_, i, all) => all.indexOf(all[i]) === i));
      expect(events.filter((e) => e.eventType === 'WalletBalanceChanged')).toHaveLength(2);
      const processed = byType.WagerTransactionProcessed;
      expect(processed).toMatchObject({
        aggregateId: bet.transactionId,
        correlationId: 'corr-evt',
        causationId: 'cause-1',
        version: 1,
        data: { status: 'PROCESSED', walletId },
      });
      expect(processed.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(processed.occurredAt).toISOString()).toBe(processed.occurredAt);
      expect(await pendingEvents()).toBe(0);
    });

    it('eventos rejeitados e pendentes seguem o tipo correto e correlação padrão', async () => {
      const { playerId } = await wallet('1.00');
      await em.execute(`update outbox_messages set status = 'PUBLISHED', published_at = now()`, [], 'run');
      const rejected = await useCase().execute({
        idempotencyKey: nextId('k'), provider: 'p', externalTransactionId: nextId('e'), playerId,
        roundId: 'r', type: 'BET', amount: { amount: '50.00', currency: 'BRL' },
      });
      const pending = await useCase().execute({
        idempotencyKey: nextId('k'), provider: 'p', externalTransactionId: nextId('e'), playerId,
        roundId: 'r', type: 'REFUND', amount: { amount: '1.00', currency: 'BRL' },
        referenceExternalTransactionId: 'nao-chegou',
      });

      await new OutboxPublisher(
        new PostgresOutboxStore(em),
        new SqsEventPublisher(queues.client, queues.urls.eventsQueueUrl),
      ).publishPending();
      const events = await collectEvents(2);

      expect(events.map((e) => e.eventType as string).sort((a, b) => (a < b ? -1 : 1))).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      const rejectedEvent = events.find((e) => e.eventType === 'WagerTransactionRejected');
      expect(rejectedEvent).toMatchObject({
        aggregateId: rejected.transactionId,
        correlationId: rejected.transactionId,
        data: { failureCode: 'INSUFFICIENT_FUNDS' },
      });
      expect(events.find((e) => e.aggregateId === pending.transactionId)).toBeDefined();
    });

    it('dois publicadores concorrentes disputando o mesmo Outbox publicam cada evento uma vez', async () => {
      const { playerId } = await wallet('1000.00');
      const useCaseInstance = useCase();
      for (let i = 0; i < 15; i++) {
        await useCaseInstance.execute({
          idempotencyKey: nextId('k'), provider: 'p', externalTransactionId: nextId('e'), playerId,
          roundId: 'r', type: 'BET', amount: { amount: '1.00', currency: 'BRL' },
        });
      }
      const total = await pendingEvents();
      const make = () =>
        new OutboxPublisher(
          new PostgresOutboxStore(em),
          new SqsEventPublisher(queues.client, queues.urls.eventsQueueUrl),
          { batchSize: 8 },
        );

      await Promise.all([make().publishPending(), make().publishPending(), make().publishPending()]);
      while ((await pendingEvents()) > 0) await make().publishPending();
      const events = await collectEvents(total);

      expect(new Set(events.map((e) => e.eventId)).size).toBe(total);
      expect(events).toHaveLength(total);
    });

    it('falha de publicação não descarta eventos confirmados e eles saem quando o broker volta', async () => {
      const { playerId } = await wallet('100.00');
      await useCase().execute({
        idempotencyKey: nextId('k'), provider: 'p', externalTransactionId: nextId('e'), playerId,
        roundId: 'r', type: 'BET', amount: { amount: '1.00', currency: 'BRL' },
      });
      const total = await pendingEvents();
      let now = new Date();
      const broken = new OutboxPublisher(
        new PostgresOutboxStore(em),
        new SqsEventPublisher(queues.client, `${queues.urls.eventsQueueUrl}-inexistente`),
        { baseBackoffMs: 1000 },
        () => now,
        telemetry(),
      );

      const failed = await broken.publishPending();

      expect(failed).toEqual({ published: 0, failed: total });
      expect(await pendingEvents()).toBe(total);
      expect(
        await scalar(em, `select count(*) from outbox_messages where status = 'PENDING' and last_error is not null and attempts = 1`),
      ).toBe(String(total));
      expect(metrics.counter('outbox_publish_failures_total', { eventType: 'WagerTransactionProcessed', final: 'false' })).toBe(1);

      now = new Date(now.getTime() + 5000);
      const healthy = new OutboxPublisher(
        new PostgresOutboxStore(em),
        new SqsEventPublisher(queues.client, queues.urls.eventsQueueUrl),
        {},
        () => now,
      );
      expect((await healthy.publishPending()).published).toBe(total);
      expect(await collectEvents(total)).toHaveLength(total);
    });

    it('commit seguido de queda antes da publicação: um novo processo publica os pendentes', async () => {
      const { playerId } = await wallet('100.00');
      await useCase().execute({
        idempotencyKey: nextId('k'), provider: 'p', externalTransactionId: nextId('e'), playerId,
        roundId: 'r', type: 'BET', amount: { amount: '1.00', currency: 'BRL' },
      });
      const total = await pendingEvents();
      const crashedStore = new PostgresOutboxStore(em);
      await crashedStore.claimBatch({ limit: 10, leaseMs: 1000, now: new Date() });

      const restarted = await createTestOrm();
      try {
        const store = new PostgresOutboxStore(restarted.em as EntityManager);
        const publisher = new OutboxPublisher(
          store,
          new SqsEventPublisher(queues.client, queues.urls.eventsQueueUrl),
          {},
          () => new Date(Date.now() + 5000),
        );

        expect((await publisher.publishPending()).published).toBe(total);
      } finally {
        await restarted.close();
      }
      expect(await collectEvents(total)).toHaveLength(total);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import { readSqsSettings } from '../../src/infrastructure/config/sqs-env';
import { createSqsClient, ensureQueues } from '../../src/infrastructure/sqs/sqs-queues';
import { nextId, rows, scalar } from '../integration/support';
import { receiveAll, sendWager, TestQueues, waitFor } from '../integration/sqs-support';
import { createApp, sqsEnv } from './support';

describe('workers integrados ao módulo Nest (e2e, SQS + PostgreSQL reais)', () => {
  let app: INestApplication;
  let em: EntityManager;
  let queues: TestQueues;
  let closed = false;

  beforeAll(async () => {
    const env = sqsEnv(`workers-${Date.now()}`, {
      WORKER_SQS_CONSUMER: 'true',
      WORKER_OUTBOX_PUBLISHER: 'true',
      WORKER_PENDING_REFERENCES: 'true',
      WORKER_RECONCILIATION: 'true',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_INTERVAL_MS: '100',
      PENDING_REFERENCE_BASE_BACKOFF_MS: '100',
      RECONCILIATION_INTERVAL_MS: '500',
    });
    const settings = readSqsSettings(env);
    const client = createSqsClient(settings);

    queues = { client, settings, urls: await ensureQueues(client, settings) };
    app = await createApp({ resetDb: true, env });
    em = app.get(EntityManager);
  });

  afterAll(async () => {
    if (!closed) await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('consome da fila, resolve a pendência, publica eventos e reconcilia em segundo plano', async () => {
    const playerId = nextId('player');
    const wallet = (
      await http()
        .post('/wallets')
        .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
        .expect(201)
    ).body;
    const betId = nextId('bet');
    const body = (overrides: Record<string, unknown>) => ({
      providerId: 'provider-w',
      playerId,
      roundId: 'r1',
      amount: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    });

    await sendWager(
      queues,
      body({ externalTransactionId: nextId('refund'), type: 'REFUND', referenceExternalTransactionId: betId }),
      { groupId: playerId },
    );
    await sendWager(queues, body({ externalTransactionId: betId, type: 'BET' }), { groupId: playerId });

    await waitFor(async () => {
      const current = (await http().get(`/wallets/${wallet.walletId}`)).body;
      return current.balance?.amount === '100.00' && current.version === 3;
    }, 20_000);

    expect(
      await scalar(em, `select status from wager_transactions where type = 'REFUND' and player_id = ?`, [playerId]),
    ).toBe('PROCESSED');

    const events = (
      await receiveAll(queues.client, queues.urls.eventsQueueUrl, 6, 20_000, true)
    ).map((message) => JSON.parse(message.Body ?? '{}'));
    const types = events.map((event) => event.eventType);

    expect(types.filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
    expect(types.filter((t) => t === 'WagerTransactionProcessed')).toHaveLength(2);
    expect(types.filter((t) => t === 'WalletBalanceChanged')).toHaveLength(3);
    expect(events.every((event) => event.version === 1 && event.correlationId && event.eventId)).toBe(true);

    await em.execute(`update wallets set balance_in_cents = balance_in_cents + 3 where id = ?`, [wallet.walletId], 'run');
    await waitFor(
      async () =>
        Number(
          await scalar(
            em,
            `select count(*) from reconciliation_discrepancies where wallet_id = ? and source = 'SCHEDULED'`,
            [wallet.walletId],
          ),
        ) === 1,
      15_000,
    );

    const metrics = (await http().get('/metrics').expect(200)).text;
    expect(metrics).toMatch(/sqs_messages_total\{result="processed"\} [1-9]/);
    expect(metrics).toMatch(/outbox_published_total\{eventType="[A-Za-z]+"\} [1-9]/);
    expect(metrics).toMatch(/pending_reference_runs_total\{outcome="processed"\} 1/);
    expect(metrics).toMatch(/wallet_reconciliations_total\{result="discrepancy"\} [1-9]/);
    expect(
      await rows(em, `select count(*)::int as n from outbox_messages where status = 'PENDING'`),
    ).toEqual([{ n: 0 }]);
  });

  it('encerramento gracioso: após close() nenhum worker consome novas mensagens', async () => {
    await app.close();
    closed = true;
    const playerId = nextId('late');
    const externalId = nextId('late-ext');

    await sendWager(
      queues,
      {
        providerId: 'provider-w',
        externalTransactionId: externalId,
        playerId,
        roundId: 'r',
        type: 'BET',
        amount: { amount: '1.00', currency: 'BRL' },
      },
      { groupId: playerId },
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const orm = await (await import('../integration/support')).createTestOrm();
    try {
      expect(
        await scalar(orm.em as EntityManager, `select count(*) from wager_transactions where external_transaction_id = ?`, [externalId]),
      ).toBe('0');
    } finally {
      await orm.close();
    }
  });
});

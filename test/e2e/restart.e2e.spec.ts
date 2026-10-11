import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import { readSqsSettings } from '../../src/infrastructure/config/sqs-env';
import { createSqsClient, ensureQueues } from '../../src/infrastructure/sqs/sqs-queues';
import { nextId, scalar } from '../integration/support';
import { receiveAll, sendWager, TestQueues, waitFor } from '../integration/sqs-support';
import { createApp, sqsEnv } from './support';

const stopCommand = process.env.PG_STOP_CMD;
const startCommand = process.env.PG_START_CMD;
const scenario = stopCommand && startCommand ? describe : describe.skip;

async function run(command: string): Promise<void> {
  const process_ = Bun.spawn(['sh', '-c', command], { stdout: 'ignore', stderr: 'ignore' });

  if ((await process_.exited) !== 0) {
    throw new Error(`Comando falhou: ${command}`);
  }
}

scenario('reinício do PostgreSQL com a aplicação em execução (e2e opcional)', () => {
  let app: INestApplication;
  let queues: TestQueues;

  beforeAll(async () => {
    const env = sqsEnv(`restart-${Date.now()}`, {
      WORKER_SQS_CONSUMER: 'true',
      WORKER_OUTBOX_PUBLISHER: 'true',
      OUTBOX_POLL_INTERVAL_MS: '200',
      SQS_RETRY_BASE_SECONDS: '1',
    });
    const settings = readSqsSettings(env);
    const client = createSqsClient(settings);

    queues = { client, settings, urls: await ensureQueues(client, settings) };
    app = await createApp({ resetDb: true, env });
  });

  afterAll(async () => {
    await app.close();
  });

  it('readiness acusa a queda, nada se perde e a aplicação se recupera sozinha', async () => {
    const http = () => request(app.getHttpServer());
    const em = app.get(EntityManager);
    const playerId = nextId('player');
    const wallet = (
      await http().post('/wallets').send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }).expect(201)
    ).body;

    await run(stopCommand as string);

    try {
      const down = await http().get('/health/ready');
      expect(down.status).toBe(503);
      expect(down.body.checks.postgres).toBe('down');
      await http().get('/health/live').expect(200);

      await sendWager(
        queues,
        {
          providerId: 'provider-r',
          externalTransactionId: nextId('during-outage'),
          playerId,
          roundId: 'r',
          type: 'BET',
          amount: { amount: '10.00', currency: 'BRL' },
        },
        { groupId: playerId },
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } finally {
      await run(startCommand as string);
    }

    await waitFor(async () => (await http().get('/health/ready')).status === 200, 30_000, 500);
    await waitFor(async () => {
      const current = (await http().get(`/wallets/${wallet.walletId}`)).body;
      return current.balance?.amount === '90.00';
    }, 40_000, 500);

    expect(
      await scalar(em, `select count(*) from wager_transactions where player_id = ? and type = 'BET'`, [playerId]),
    ).toBe('1');
    expect(
      await scalar(em, `select count(*) from wallet_ledger_entries where wallet_id = ? and entry_type = 'BET'`, [wallet.walletId]),
    ).toBe('1');

    await waitFor(
      async () => (await scalar(em, `select count(*) from outbox_messages where status = 'PENDING'`)) === '0',
      30_000,
      500,
    );
    const events = await receiveAll(queues.client, queues.urls.eventsQueueUrl, 3, 20_000, true);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

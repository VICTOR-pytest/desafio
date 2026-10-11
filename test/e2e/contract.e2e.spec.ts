import type { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import { SQSClient } from '@aws-sdk/client-sqs';
import { HealthController } from '../../src/infrastructure/http/health.controller';
import { nextId, rows, scalar } from '../integration/support';
import { createApp, sqsEnv } from './support';

describe('contrato HTTP do desafio (e2e, PostgreSQL 17 + LocalStack reais)', () => {
  let app: INestApplication;
  let em: EntityManager;

  beforeAll(async () => {
    app = await createApp({ resetDb: true, env: sqsEnv(`contract-${Date.now()}`) });
    em = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const openWallet = async (amount = '100.00') => {
    const playerId = nextId('player');
    const response = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount, currency: 'BRL' } })
      .expect(201);
    return { playerId, ...response.body } as {
      playerId: string;
      walletId: string;
      version: number;
    };
  };

  const submit = (payload: object, key: string | null = nextId('key'), path = '/wagering/transactions') => {
    const call = http().post(path);
    if (key !== null) call.set('Idempotency-Key', key);
    return call.send(payload);
  };

  const tx = (playerId: string, overrides: Record<string, unknown> = {}) => ({
    providerId: 'provider-1',
    externalTransactionId: nextId('ext'),
    playerId,
    roundId: 'round-1',
    type: 'BET',
    amount: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  });

  describe('POST /wallets e GET /wallets/:walletId', () => {
    it('aceita { playerId, initialBalance } e devolve identificador, jogador, saldo e versão', async () => {
      const playerId = nextId('player');

      const response = await http()
        .post('/wallets')
        .send({ playerId, initialBalance: { amount: '250.50', currency: 'BRL' } })
        .expect(201);

      expect(response.body).toEqual({
        walletId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        playerId,
        currency: 'BRL',
        balance: { amount: '250.50', currency: 'BRL' },
        version: 1,
      });
      await http().get(`/wallets/${response.body.walletId}`).expect(200, response.body);
    });

    it('mantém o formato anterior e rejeita misturar os dois', async () => {
      await http()
        .post('/wallets')
        .send({ playerId: nextId('p'), currency: 'BRL', openingBalance: '1.00' })
        .expect(201);
      await http()
        .post('/wallets')
        .send({ playerId: nextId('p'), currency: 'BRL', initialBalance: { amount: '1.00', currency: 'BRL' } })
        .expect(400);
    });

    it.each([
      ['valor numérico', { amount: 10, currency: 'BRL' }],
      ['escala inválida', { amount: '10.5', currency: 'BRL' }],
      ['negativo', { amount: '-1.00', currency: 'BRL' }],
      ['campo extra', { amount: '1.00', currency: 'BRL', extra: 1 }],
    ])('rejeita initialBalance com %s', async (_, initialBalance) => {
      await http().post('/wallets').send({ playerId: nextId('p'), initialBalance }).expect(400);
    });

    it('responde 409 para carteira duplicada e 404 para id desconhecido ou malformado', async () => {
      const { playerId } = await openWallet();

      await http()
        .post('/wallets')
        .send({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })
        .expect(409);
      await http().get('/wallets/00000000-0000-0000-0000-000000000000').expect(404);
      await http().get('/wallets/nao-e-um-uuid').expect(404);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('devolve a resposta completa e o replay com o saldo original', async () => {
      const { playerId, walletId } = await openWallet('100.00');
      const payload = tx(playerId, { walletId });
      const key = nextId('key');

      const first = await submit(payload, key).expect(201);
      await submit(tx(playerId, { walletId, amount: { amount: '20.00', currency: 'BRL' } })).expect(201);
      const replay = await submit(payload, key).expect(200);

      expect(first.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        failureCode: null,
        idempotentReplay: false,
        wallet: { walletId, balance: { amount: '90.00', currency: 'BRL' }, version: 2 },
      });
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect((await http().get(`/wallets/${walletId}`).expect(200)).body.balance.amount).toBe('70.00');
    });

    it('exige Idempotency-Key, responde 409 em conflito, 422 em rejeição e 202 em pendência', async () => {
      const { playerId } = await openWallet('5.00');
      const payload = tx(playerId, { amount: { amount: '1.00', currency: 'BRL' } });
      const key = nextId('key');
      await submit(payload, key).expect(201);

      const missing = await submit(payload, null).expect(400);
      const conflict = await submit({ ...payload, roundId: 'outra' }, key).expect(409);
      const rejected = await submit(tx(playerId, { amount: { amount: '50.00', currency: 'BRL' } })).expect(422);
      const pending = await submit(
        tx(playerId, { type: 'REFUND', referenceExternalTransactionId: 'ainda-nao-chegou' }),
      ).expect(202);

      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(pending.body.status).toBe('PENDING_REFERENCE');
    });

    it('aceita valor em objeto ou em campos separados, nunca duplicado nem numérico', async () => {
      const { playerId } = await openWallet();

      await submit(tx(playerId, { amount: '5.00', currency: 'BRL' })).expect(201);
      await submit(tx(playerId, { currency: 'BRL' })).expect(400);
      await submit(tx(playerId, { amount: 5 })).expect(400);
      await submit(tx(playerId, { provider: 'x' })).expect(400);
    });

    it('mantém a rota anterior /wager-transactions', async () => {
      const { playerId } = await openWallet();

      await submit(tx(playerId), nextId('k'), '/wager-transactions').expect(201);
    });
  });

  describe('consultas de transação', () => {
    it('GET por id e por provedor + identificador externo', async () => {
      const { playerId, walletId } = await openWallet();
      const payload = tx(playerId);
      const created = await submit(payload).expect(201);

      const byId = await http().get(`/wagering/transactions/${created.body.transactionId}`).expect(200);
      const byExternal = await http()
        .get(`/providers/provider-1/wagering/transactions/${payload.externalTransactionId}`)
        .expect(200);

      expect(byId.body).toMatchObject({
        transactionId: created.body.transactionId,
        providerId: 'provider-1',
        externalTransactionId: payload.externalTransactionId,
        walletId,
        status: 'PROCESSED',
        type: 'BET',
        amount: { amount: '10.00', currency: 'BRL' },
      });
      expect(byExternal.body).toEqual(byId.body);
    });

    it('responde 404 para transação desconhecida e para provedor diferente', async () => {
      const { playerId } = await openWallet();
      const payload = tx(playerId);
      await submit(payload).expect(201);

      await http().get('/wagering/transactions/00000000-0000-0000-0000-000000000000').expect(404);
      await http().get('/wagering/transactions/xyz').expect(404);
      await http()
        .get(`/providers/outro/wagering/transactions/${payload.externalTransactionId}`)
        .expect(404);
    });

    it('a consulta mostra o estado atual, não o da submissão original', async () => {
      const { playerId } = await openWallet('100.00');
      const bet = tx(playerId);
      const refund = await submit(
        tx(playerId, { type: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
      ).expect(202);
      await submit(bet).expect(201);

      await em.execute(
        `update wager_transactions set status = 'REJECTED', failure_code = 'PENDING_REFERENCE_EXPIRED', processed_at = now() where id = ?`,
        [refund.body.transactionId],
        'run',
      );

      const current = await http().get(`/wagering/transactions/${refund.body.transactionId}`).expect(200);
      expect(current.body).toMatchObject({ status: 'REJECTED', failureCode: 'PENDING_REFERENCE_EXPIRED' });
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('pagina com limit e cursor opaco e fecha com nextCursor nulo', async () => {
      const { playerId, walletId } = await openWallet('1000.00');
      for (let i = 0; i < 11; i++) await submit(tx(playerId)).expect(201);

      const pages: Array<{ items: Array<{ entryId: string }>; nextCursor: string | null }> = [];
      let cursor: string | null = null;

      do {
        const url: string = `/wallets/${walletId}/ledger?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
        const body = (await http().get(url).expect(200)).body;
        pages.push(body);
        cursor = body.nextCursor;
      } while (cursor);

      const ids = pages.flatMap((page) => page.items.map((item) => item.entryId));
      expect(pages.map((page) => page.items.length)).toEqual([5, 5, 2]);
      expect(new Set(ids).size).toBe(12);
    });

    it('usa limit 50 por padrão e valida cursor e limit', async () => {
      const { walletId } = await openWallet();

      const defaultPage = await http().get(`/wallets/${walletId}/ledger`).expect(200);
      expect(defaultPage.body.items).toHaveLength(1);
      expect(defaultPage.body.nextCursor).toBeNull();
      await http().get(`/wallets/${walletId}/ledger?cursor=invalido`).expect(400);
      await http().get(`/wallets/${walletId}/ledger?limit=0`).expect(400);
      await http().get(`/wallets/${walletId}/ledger?limit=abc`).expect(400);
      await http().get(`/wallets/${walletId}/ledger?limit=201`).expect(400);
      await http().get('/wallets/00000000-0000-0000-0000-000000000000/ledger').expect(404);
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('confirma a consistência e, com divergência, registra sem corrigir o saldo', async () => {
      const { playerId, walletId } = await openWallet('100.00');
      await submit(tx(playerId)).expect(201);

      const ok = await http().post(`/wallets/${walletId}/reconciliation`).expect(200);
      await em.execute(`update wallets set balance_in_cents = balance_in_cents + 9 where id = ?`, [walletId], 'run');
      const bad = await http().post(`/wallets/${walletId}/reconciliation`).expect(200);

      expect(ok.body).toMatchObject({ status: 'CONSISTENT', discrepancyId: null });
      expect(bad.body).toMatchObject({
        status: 'DISCREPANCY',
        difference: { amount: '0.09' },
        discrepancyId: expect.any(String),
      });
      expect((await http().get(`/wallets/${walletId}`).expect(200)).body.balance.amount).toBe('90.09');
      await http().post('/wallets/00000000-0000-0000-0000-000000000000/reconciliation').expect(404);
    });
  });

  describe('observabilidade', () => {
    it('separa liveness de readiness e verifica PostgreSQL e SQS', async () => {
      await http().get('/health/live').expect(200, { status: 'ok' });
      const ready = await http().get('/health/ready').expect(200);

      expect(ready.body).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
    });

    it('readiness devolve 503 quando o SQS está inacessível', async () => {
      const unreachable = new SQSClient({
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9',
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        maxAttempts: 1,
      });
      const controller = new HealthController({
        em,
        sqs: { client: unreachable, queueUrl: 'http://127.0.0.1:9/000000000000/q.fifo' },
      });
      let status = 200;

      const body = await controller.ready({ status: (code: number) => ((status = code), undefined) });

      expect(status).toBe(503);
      expect(body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
    });

    it('devolve e propaga o X-Correlation-Id até os eventos do Outbox', async () => {
      const { playerId } = await openWallet();

      const supplied = await submit(tx(playerId)).set('X-Correlation-Id', 'corr-abc-123').expect(201);
      const generated = await submit(tx(playerId)).expect(201);

      expect(supplied.headers['x-correlation-id']).toBe('corr-abc-123');
      expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await scalar(
          em,
          `select count(*) from outbox_messages where correlation_id = 'corr-abc-123' and aggregate_id = ?`,
          [supplied.body.transactionId],
        ),
      ).toBe('1');
    });

    it('expõe métricas por estado, duplicidade, conflito, latência e atraso do Outbox', async () => {
      const { playerId } = await openWallet('50.00');
      const payload = tx(playerId);
      const key = nextId('key');
      await submit(payload, key).expect(201);
      await submit(payload, key).expect(200);
      await submit({ ...payload, roundId: 'x' }, key).expect(409);
      await submit(tx(playerId, { amount: { amount: '99.00', currency: 'BRL' } })).expect(422);

      const metrics = (await http().get('/metrics').expect(200)).text;

      expect(metrics).toContain('wager_transactions_total{status="PROCESSED",type="BET"}');
      expect(metrics).toContain('wager_transactions_total{status="REJECTED",type="BET"}');
      expect(metrics).toMatch(/wager_duplicates_total\{source="http"\} [1-9]/);
      expect(metrics).toMatch(/wager_idempotency_conflicts_total [1-9]/);
      expect(metrics).toMatch(/wager_processing_duration_seconds_count [1-9]/);
      expect(metrics).toMatch(/outbox_lag_seconds [0-9.]+/);
    });

    it('não registra segredos nem payloads financeiros completos nos logs', async () => {
      const lines: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      const { playerId } = await openWallet();

      try {
        await submit(tx(playerId, { amount: { amount: '77.77', currency: 'BRL' } })).expect(201);
      } finally {
        process.stdout.write = original;
      }

      const output = lines.join('');
      expect(output).toContain('transaction processed');
      expect(output).not.toContain('77.77');
      expect(output).not.toMatch(/secret|password|test"/i);
      for (const line of output.split('\n').filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  it('o ledger permanece imutável e reconciliável depois de todo o tráfego do contrato', async () => {
    const inconsistent = await rows(
      em,
      `select w.id from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
       group by w.id, w.balance_in_cents
       having w.balance_in_cents <> coalesce(sum(case l.direction when 'CREDIT' then l.amount_in_cents else -l.amount_in_cents end), 0)
          and w.balance_in_cents <> 0`,
    );
    const tampered = await rows(em, `select wallet_id from reconciliation_discrepancies`);

    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const tamperedIds = [...new Set(tampered.map((row) => row.wallet_id as string))];

    expect(inconsistent.map((row) => row.id as string).sort(byText)).toEqual(
      tamperedIds.sort(byText),
    );
    expect(await scalar(em, `select count(*) from wallets where balance_in_cents < 0`)).toBe('0');
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createTestOrm, nextId, resetDatabase, testDatabaseName } from '../integration/support';

describe('API HTTP (e2e, PostgreSQL real)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DB_NAME = testDatabaseName();

    const orm = await createTestOrm();
    await resetDatabase(orm);
    await orm.close();

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const openWallet = async (balance = '100.00') => {
    const playerId = nextId('player');
    await http()
      .post('/wallets')
      .send({ playerId, currency: 'BRL', openingBalance: balance })
      .expect(201);
    return playerId;
  };

  const body = (playerId: string, overrides: Record<string, unknown> = {}) => ({
    provider: 'provider-1',
    externalTransactionId: nextId('ext'),
    playerId,
    roundId: 'round-1',
    type: 'BET',
    amount: '10.00',
    currency: 'BRL',
    ...overrides,
  });

  const send = (payload: object, key: string | null = nextId('key')) => {
    const call = http().post('/wager-transactions');
    if (key !== null) call.set('Idempotency-Key', key);
    return call.send(payload);
  };

  const balance = async (playerId: string) =>
    (await http().get(`/wallets/${playerId}/BRL`).expect(200)).body.balance.amount;

  it('GET /health responde ok', async () => {
    await http().get('/health').expect(200, { status: 'ok' });
  });

  it('não expõe mais o endpoint de exemplo na raiz', async () => {
    await http().get('/').expect(404);
  });

  describe('carteiras', () => {
    it('abre e consulta uma carteira', async () => {
      const playerId = nextId('player');

      const created = await http()
        .post('/wallets')
        .send({ playerId, currency: 'BRL', openingBalance: '100.00' })
        .expect(201);

      expect(created.body).toMatchObject({
        playerId,
        currency: 'BRL',
        balance: { amount: '100.00', currency: 'BRL' },
      });
      await http()
        .get(`/wallets/${playerId}/BRL`)
        .expect(200)
        .expect((response) => {
          expect(response.body.walletId).toBe(created.body.walletId);
        });
    });

    it('retorna 409 para carteira duplicada e 404 para inexistente', async () => {
      const playerId = await openWallet();

      const duplicate = await http()
        .post('/wallets')
        .send({ playerId, currency: 'BRL', openingBalance: '1.00' })
        .expect(409);
      expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');

      const missing = await http().get(`/wallets/${nextId('x')}/BRL`).expect(404);
      expect(missing.body.code).toBe('WALLET_NOT_FOUND');
    });

    it('rejeita saldo numérico, escala errada e campos desconhecidos', async () => {
      const playerId = nextId('player');

      await http().post('/wallets').send({ playerId, currency: 'BRL', openingBalance: 100 }).expect(400);
      await http().post('/wallets').send({ playerId, currency: 'BRL', openingBalance: '100.5' }).expect(400);
      await http().post('/wallets').send({ playerId, currency: 'BRL', openingBalance: '-1.00' }).expect(400);
      await http().post('/wallets').send({ playerId, currency: 'BRL', openingBalance: '1.00', x: 1 }).expect(400);
      await http().get(`/wallets/${playerId}/BRL`).expect(404);
    });
  });

  describe('transações', () => {
    it('exige Idempotency-Key', async () => {
      const playerId = await openWallet();

      const response = await send(body(playerId), null).expect(400);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(await balance(playerId)).toBe('100.00');
    });

    it.each([
      ['valor numérico', { amount: 10.5 }],
      ['escala errada', { amount: '10.5' }],
      ['valor negativo', { amount: '-10.00' }],
      ['notação científica', { amount: '1e3' }],
      ['moeda inválida', { currency: 'real' }],
      ['campo desconhecido', { extra: true }],
      ['campo obrigatório vazio', { roundId: '' }],
      ['tipo inválido', { type: 'DEPOSIT' }],
      ['OPENING externo', { type: 'OPENING' }],
      ['REFUND sem referência', { type: 'REFUND' }],
      ['BET com referência', { referenceExternalTransactionId: 'x' }],
    ])('rejeita %s com 400 e sem mutação', async (_, overrides) => {
      const playerId = await openWallet();

      await send(body(playerId, overrides)).expect(400);

      expect(await balance(playerId)).toBe('100.00');
    });

    it('processa BET com 201 e depois responde o replay com 200', async () => {
      const playerId = await openWallet();
      const payload = body(playerId);
      const key = nextId('key');

      const first = await send(payload, key).expect(201);
      const replay = await send(payload, key).expect(200);

      expect(first.body).toMatchObject({ status: 'PROCESSED', failureCode: null, idempotentReplay: false });
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await balance(playerId)).toBe('90.00');
    });

    it('retorna 409 para a mesma chave com payload diferente', async () => {
      const playerId = await openWallet();
      const payload = body(playerId);
      const key = nextId('key');
      await send(payload, key).expect(201);

      const conflict = await send({ ...payload, amount: '99.00' }, key).expect(409);

      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await balance(playerId)).toBe('90.00');
    });

    it('retorna 422 para saldo insuficiente sem mutação e mantém o replay', async () => {
      const playerId = await openWallet('5.00');
      const payload = body(playerId, { amount: '50.00' });
      const key = nextId('key');

      const rejected = await send(payload, key).expect(422);
      const replay = await send(payload, key).expect(422);

      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      expect(replay.body.idempotentReplay).toBe(true);
      expect(await balance(playerId)).toBe('5.00');
    });

    it('retorna 422 WALLET_NOT_FOUND para jogador sem carteira', async () => {
      const response = await send(body(nextId('ghost'))).expect(422);

      expect(response.body.failureCode).toBe('WALLET_NOT_FOUND');
    });

    it('cobre WIN, LOSS, REFUND, ROLLBACK e PENDING_REFERENCE', async () => {
      const playerId = await openWallet('100.00');
      const bet = body(playerId, { amount: '40.00' });
      await send(bet).expect(201);

      const win = body(playerId, { type: 'WIN', amount: '15.00' });
      await send(win).expect(201);
      await send(body(playerId, { type: 'LOSS', amount: '40.00' })).expect(201);
      expect(await balance(playerId)).toBe('75.00');

      await send(
        body(playerId, {
          type: 'REFUND',
          amount: '40.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ).expect(201);
      expect(await balance(playerId)).toBe('115.00');

      const second = await send(
        body(playerId, {
          type: 'REFUND',
          amount: '40.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ).expect(422);
      expect(second.body.failureCode).toBe('ALREADY_REVERSED');

      await send(
        body(playerId, {
          type: 'ROLLBACK',
          amount: '15.00',
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      ).expect(201);
      expect(await balance(playerId)).toBe('100.00');

      const pending = await send(
        body(playerId, {
          type: 'REFUND',
          amount: '1.00',
          referenceExternalTransactionId: 'ainda-nao-chegou',
        }),
      ).expect(202);
      expect(pending.body.status).toBe('PENDING_REFERENCE');
      expect(await balance(playerId)).toBe('100.00');
    });

    it('com duas BETs HTTP simultâneas de 80,00 sobre 100,00, uma é aceita e uma rejeitada', async () => {
      const playerId = await openWallet('100.00');

      const responses = await Promise.all([
        send(body(playerId, { amount: '80.00' })),
        send(body(playerId, { amount: '80.00' })),
      ]);

      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 422]);
      expect(await balance(playerId)).toBe('20.00');
    });

    it('com 50 requisições simultâneas idênticas, há um único efeito', async () => {
      const playerId = await openWallet('100.00');
      const payload = body(playerId);
      const key = nextId('key');

      const responses = await Promise.all(
        Array.from({ length: 50 }, () => send(payload, key)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(49);
      expect(await balance(playerId)).toBe('90.00');
    });

    it('não vaza detalhes internos em erros inesperados', async () => {
      await http()
        .post('/wager-transactions')
        .set('Idempotency-Key', 'k')
        .set('Content-Type', 'application/json')
        .send('{"quebrado":')
        .expect(400);
    });
  });
});

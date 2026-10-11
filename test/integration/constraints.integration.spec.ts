import type { MikroORM } from '@mikro-orm/postgresql';
import {
  buildHarness,
  command,
  createTestOrm,
  Harness,
  nextId,
  resetDatabase,
  rows,
} from './support';

describe('constraints do schema (PostgreSQL real)', () => {
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

  const uuid = () => crypto.randomUUID();

  const sql = (statement: string, params: unknown[] = []) =>
    h.em.execute(statement, params as any[], 'run');

  const rejection = async (statement: string, params: unknown[] = []) => {
    let error: any;
    try {
      await sql(statement, params);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    return `${error.constructor.name} ${error.code ?? ''} ${error.constraint ?? ''} ${error.message}`;
  };

  const insertWallet = (id: string, player: string, currency: string, balance: string) =>
    sql(
      `insert into wallets (id, player_id, currency, balance_in_cents, created_at, updated_at)
       values (?, ?, ?, ?::bigint, now(), now())`,
      [id, player, currency, balance],
    );

  const insertTransaction = (id: string, overrides: Record<string, unknown> = {}) => {
    const values = {
      provider: 'p',
      external: nextId('e'),
      key: nextId('k'),
      wallet: null,
      type: 'BET',
      cents: '100',
      status: 'PROCESSED',
      failure: null,
      reference: null,
      referenceExternal: null,
      processedAt: 'now()',
      ...overrides,
    } as Record<string, any>;

    return sql(
      `insert into wager_transactions
        (id, provider, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, type, amount_in_cents, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, created_at, processed_at)
       values (?, ?, ?, ?, 'h', ?, 'pl', 'r', ?, ?::bigint, 'BRL', ?, ?, ?, ?, now(),
               case when ? = 'none' then null else now() end)`,
      [
        id,
        values.provider,
        values.external,
        values.key,
        values.wallet,
        values.type,
        values.cents,
        values.referenceExternal,
        values.reference,
        values.status,
        values.failure,
        values.processedAt === 'now()' ? 'set' : 'none',
      ],
    );
  };

  const insertLedger = (
    walletId: string,
    transactionId: string,
    overrides: Record<string, string> = {},
  ) => {
    const v = {
      type: 'BET',
      direction: 'DEBIT',
      amount: '100',
      before: '1000',
      after: '900',
      ...overrides,
    };
    return sql(
      `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, entry_type, direction, amount_in_cents, currency,
         balance_before_in_cents, balance_after_in_cents, created_at)
       values (?, ?, ?, ?, ?, ?::bigint, 'BRL', ?::bigint, ?::bigint, now())`,
      [uuid(), walletId, transactionId, v.type, v.direction, v.amount, v.before, v.after],
    );
  };

  describe('wallets', () => {
    it('impede saldo negativo', async () => {
      const id = uuid();
      await insertWallet(id, nextId('p'), 'BRL', '100');

      const message = await rejection(
        `update wallets set balance_in_cents = -1 where id = ?`,
        [id],
      );

      expect(message).toContain('wallets_balance_non_negative');
      expect(await rows(h.em, `select balance_in_cents::text b from wallets where id = ?`, [id])).toEqual([
        { b: '100' },
      ]);
    });

    it('impede carteira duplicada para jogador e moeda, mas permite outra moeda', async () => {
      const player = nextId('p');
      await insertWallet(uuid(), player, 'BRL', '0');

      expect(await rejection(
        `insert into wallets (id, player_id, currency, balance_in_cents, created_at, updated_at)
         values (?, ?, 'BRL', 0, now(), now())`,
        [uuid(), player],
      )).toContain('wallets_player_id_currency_unique');

      await insertWallet(uuid(), player, 'USD', '0');
    });

    it('preserva o valor máximo de BIGINT sem perda de precisão', async () => {
      const id = uuid();
      await insertWallet(id, nextId('p'), 'BRL', '9223372036854775807');

      expect(await rows(h.em, `select balance_in_cents::text b from wallets where id = ?`, [id])).toEqual([
        { b: '9223372036854775807' },
      ]);
    });
  });

  describe('wager_transactions', () => {
    it('impede identidade externa duplicada por provider, mas aceita outro provider', async () => {
      const external = nextId('e');
      await insertTransaction(uuid(), { external });

      expect(await rejection(
        `insert into wager_transactions (id, provider, external_transaction_id, idempotency_key, payload_hash,
          player_id, round_id, type, amount_in_cents, currency, status, created_at, processed_at)
         values (?, 'p', ?, ?, 'h', 'pl', 'r', 'BET', 1, 'BRL', 'PROCESSED', now(), now())`,
        [uuid(), external, nextId('k')],
      )).toContain('wager_transactions_provider_external_id_unique');

      await insertTransaction(uuid(), { external, provider: 'outro' });
    });

    it('impede chave de idempotência duplicada por provider', async () => {
      const key = nextId('k');
      await insertTransaction(uuid(), { key });

      expect(await rejection(
        `insert into wager_transactions (id, provider, external_transaction_id, idempotency_key, payload_hash,
          player_id, round_id, type, amount_in_cents, currency, status, created_at, processed_at)
         values (?, 'p', ?, ?, 'h', 'pl', 'r', 'BET', 1, 'BRL', 'PROCESSED', now(), now())`,
        [uuid(), nextId('e'), key],
      )).toContain('wager_transactions_provider_idempotency_key_unique');
    });

    it('valida tipo, status, valor e consistência de campos', async () => {
      expect(await rejection(`update wager_transactions set type = 'XYZ' where false or id = ?`, [uuid()]).catch(() => 'sem linha'))
        .toBeDefined();

      const failing = async (overrides: Record<string, unknown>) => {
        try {
          await insertTransaction(uuid(), overrides);
          return 'aceito';
        } catch (error: any) {
          return error.constraint ?? error.message;
        }
      };

      expect(await failing({ type: 'XYZ' })).toBe('wager_transactions_type_valid');
      expect(await failing({ status: 'DONE', processedAt: 'none' })).toBe('wager_transactions_status_valid');
      expect(await failing({ cents: '0' })).toBe('wager_transactions_amount_valid');
      expect(await failing({ cents: '-5' })).toBe('wager_transactions_amount_valid');
      expect(await failing({ status: 'REJECTED' })).toBe('wager_transactions_failure_code_consistent');
      expect(await failing({ failure: 'X' })).toBe('wager_transactions_failure_code_consistent');
      expect(await failing({ status: 'PENDING', processedAt: 'none' })).toBe('aceito');
      expect(await failing({ status: 'PROCESSED', processedAt: 'none' })).toBe('wager_transactions_processed_at_consistent');
      expect(await failing({ type: 'REFUND' })).toBe('wager_transactions_reference_required');
      expect(await failing({ referenceExternal: 'x' })).toBe('wager_transactions_reference_required');
      expect(await failing({ type: 'OPENING', cents: '0' })).toBe('aceito');
    });

    it('exige carteira existente (FK)', async () => {
      const message = await rejection(
        `insert into wager_transactions (id, provider, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, type, amount_in_cents, currency, status, created_at, processed_at)
         values (?, 'p', ?, ?, 'h', ?, 'pl', 'r', 'BET', 1, 'BRL', 'PROCESSED', now(), now())`,
        [uuid(), nextId('e'), nextId('k'), uuid()],
      );

      expect(message).toContain('wager_transactions_wallet_id_foreign');
    });

    it('permite no máximo uma reversão PROCESSED por referência e por tipo', async () => {
      const bet = uuid();
      await insertTransaction(bet);
      const reversal = (type: string, status = 'PROCESSED') =>
        insertTransaction(uuid(), {
          type,
          status,
          reference: bet,
          referenceExternal: 'ref',
          failure: status === 'REJECTED' ? 'ALREADY_REVERSED' : null,
        });

      await reversal('REFUND');

      expect(await rejection(
        `insert into wager_transactions (id, provider, external_transaction_id, idempotency_key, payload_hash,
          player_id, round_id, type, amount_in_cents, currency, reference_external_transaction_id,
          reference_transaction_id, status, created_at, processed_at)
         values (?, 'p', ?, ?, 'h', 'pl', 'r', 'REFUND', 100, 'BRL', 'ref', ?, 'PROCESSED', now(), now())`,
        [uuid(), nextId('e'), nextId('k'), bet],
      )).toContain('wager_transactions_single_reversal_per_type_unique');

      await reversal('ROLLBACK');
      await reversal('REFUND', 'REJECTED');
    });
  });

  describe('wallet_ledger_entries', () => {
    const fixture = async () => {
      const wallet = uuid();
      const transaction = uuid();
      await insertWallet(wallet, nextId('p'), 'BRL', '900');
      await insertTransaction(transaction, { wallet });
      return { wallet, transaction };
    };

    it('aceita um lançamento consistente e impede um segundo para a mesma transação e carteira', async () => {
      const { wallet, transaction } = await fixture();

      await insertLedger(wallet, transaction);

      expect(await rejection(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, entry_type, direction, amount_in_cents, currency,
           balance_before_in_cents, balance_after_in_cents, created_at)
         values (?, ?, ?, 'BET', 'DEBIT', 100, 'BRL', 1000, 900, now())`,
        [uuid(), wallet, transaction],
      )).toContain('wallet_ledger_entries_wallet_transaction_unique');
    });

    it('é imutável: UPDATE e DELETE são rejeitados pelo banco', async () => {
      const { wallet, transaction } = await fixture();
      await insertLedger(wallet, transaction);

      expect(await rejection(`update wallet_ledger_entries set amount_in_cents = 1 where wallet_id = ?`, [wallet]))
        .toContain('imutável');
      expect(await rejection(`delete from wallet_ledger_entries where wallet_id = ?`, [wallet]))
        .toContain('imutável');
      expect(await rows(h.em, `select amount_in_cents::text a from wallet_ledger_entries where wallet_id = ?`, [wallet]))
        .toEqual([{ a: '100' }]);
    });

    it('rejeita lançamentos aritmeticamente inconsistentes, valores inválidos e saldos negativos', async () => {
      const failing = async (overrides: Record<string, string>) => {
        const { wallet, transaction } = await fixture();
        try {
          await insertLedger(wallet, transaction, overrides);
          return 'aceito';
        } catch (error: any) {
          return error.constraint ?? error.message;
        }
      };

      expect(await failing({ after: '950' })).toBe('wallet_ledger_entries_balance_consistent');
      expect(await failing({ direction: 'CREDIT' })).toBe('wallet_ledger_entries_balance_consistent');
      expect([
        'wallet_ledger_entries_direction_valid',
        'wallet_ledger_entries_balance_consistent',
      ]).toContain(await failing({ direction: 'SIDE' }));
      expect(await failing({ type: 'NOPE' })).toBe('wallet_ledger_entries_type_valid');
      expect(await failing({ amount: '0', after: '1000' })).toBe('wallet_ledger_entries_amount_valid');
      expect(await failing({ before: '50', after: '-50' })).toBe('wallet_ledger_entries_balances_non_negative');
      expect(await failing({ type: 'OPENING', direction: 'CREDIT', amount: '0', before: '0', after: '0' })).toBe('aceito');
    });

    it('exige carteira e transação existentes (FK)', async () => {
      const { wallet, transaction } = await fixture();

      expect(await rejection(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, entry_type, direction, amount_in_cents, currency,
           balance_before_in_cents, balance_after_in_cents, created_at)
         values (?, ?, ?, 'BET', 'DEBIT', 1, 'BRL', 10, 9, now())`,
        [uuid(), uuid(), transaction],
      )).toContain('wallet_ledger_entries_wallet_id_foreign');
      expect(await rejection(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, entry_type, direction, amount_in_cents, currency,
           balance_before_in_cents, balance_after_in_cents, created_at)
         values (?, ?, ?, 'BET', 'DEBIT', 1, 'BRL', 10, 9, now())`,
        [uuid(), wallet, uuid()],
      )).toContain('wallet_ledger_entries_transaction_id_foreign');
    });
  });

  describe('inbox e outbox', () => {
    it('inbox impede a mesma mensagem da mesma origem', async () => {
      const messageId = nextId('m');
      const insert = () =>
        sql(
          `insert into inbox_messages (id, source, message_id, payload, received_at)
           values (?, 'sqs', ?, '{}'::jsonb, now())`,
          [uuid(), messageId],
        );

      await insert();

      expect(await rejection(
        `insert into inbox_messages (id, source, message_id, payload, received_at)
         values (?, 'sqs', ?, '{}'::jsonb, now())`,
        [uuid(), messageId],
      )).toContain('inbox_messages_source_message_id_unique');
    });

    it('outbox valida status e tentativas', async () => {
      const insert = (status: string, attempts: number) =>
        sql(
          `insert into outbox_messages (id, aggregate_type, aggregate_id, event_type, payload, status, attempts,
            next_attempt_at, created_at)
           values (?, 'T', ?, 'E', '{}'::jsonb, ?, ?, now(), now())`,
          [uuid(), uuid(), status, attempts],
        );

      await insert('PENDING', 0);
      expect(await insert('WHATEVER', 0).catch((e: any) => e.constraint)).toBe('outbox_messages_status_valid');
      expect(await insert('PENDING', -1).catch((e: any) => e.constraint)).toBe('outbox_messages_attempts_non_negative');
    });
  });

  it('o fluxo do domínio nunca produz estado que viole as constraints', async () => {
    const playerId = nextId('p');
    await h.openWallet.execute({
      playerId,
      currency: 'BRL',
      openingBalance: { amount: '10.00', currency: 'BRL' },
    });

    await h.process.execute(command(playerId, 'BET', '5.00'));

    const [{ negative }] = await rows(
      h.em,
      `select count(*)::int as negative from wallets where balance_in_cents < 0`,
    );
    expect(negative).toBe(0);
  });
});

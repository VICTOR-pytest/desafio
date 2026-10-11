import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { GetWalletUseCase } from '../../src/application/get-wallet.use-case';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  ProcessWagerCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction.use-case';
import { UnitOfWork } from '../../src/application/ports';
import { readDatabaseSettings } from '../../src/infrastructure/config/env';
import { buildMikroOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';

export function testDatabaseName(): string {
  const name = process.env.TEST_DB_NAME;

  if (!name || !name.endsWith('_test')) {
    throw new Error(
      'TEST_DB_NAME é obrigatório e deve terminar com _test para proteger outros bancos',
    );
  }

  return name;
}

export async function createTestOrm(): Promise<MikroORM> {
  const settings = readDatabaseSettings({
    ...process.env,
    DB_NAME: testDatabaseName(),
  });

  const config = buildMikroOrmConfig(settings);

  return MikroORM.init({
    ...config,
    preferTs: true,
    migrations: { ...config.migrations, snapshot: false },
  });
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  testDatabaseName();
  const em = orm.em as EntityManager;

  await em.execute('drop schema if exists public cascade', [], 'run');
  await em.execute('create schema public', [], 'run');
  await orm.migrator.up();
}

export async function clearData(orm: MikroORM): Promise<void> {
  testDatabaseName();

  await (orm.em as EntityManager).execute(
    `truncate table reconciliation_discrepancies, outbox_messages, inbox_messages,
       wallet_ledger_entries, wager_transactions, wallets restart identity cascade`,
    [],
    'run',
  );
}

export function buildHarness(
  orm: MikroORM,
  unitOfWork: UnitOfWork = new PostgresUnitOfWork(orm.em as EntityManager),
) {
  return {
    em: orm.em as EntityManager,
    unitOfWork,
    process: new ProcessWagerTransactionUseCase(unitOfWork),
    openWallet: new OpenWalletUseCase(unitOfWork),
    getWallet: new GetWalletUseCase(unitOfWork),
  };
}

export type Harness = ReturnType<typeof buildHarness>;

let sequence = 0;

export const nextId = (prefix: string) => `${prefix}-${++sequence}-${Date.now()}`;

export function command(
  playerId: string,
  type: ProcessWagerCommand['type'],
  amount: string,
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  const id = nextId('ext');

  return {
    idempotencyKey: `key-${id}`,
    provider: 'provider-1',
    externalTransactionId: id,
    playerId,
    roundId: 'round-1',
    type,
    amount: { amount, currency: 'BRL' },
    ...overrides,
  };
}

export async function rows<T = Record<string, any>>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await em.execute(sql, params as any[], 'all')) as T[];
}

export async function scalar(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  const [row] = await rows(em, sql, params);
  return String(Object.values(row)[0]);
}

export async function balanceOf(
  harness: Harness,
  playerId: string,
  currency = 'BRL',
): Promise<string> {
  return (await harness.getWallet.execute(playerId, currency)).balance.amount;
}

export async function ledgerNet(
  em: EntityManager,
  walletId: string,
): Promise<string> {
  return scalar(
    em,
    `select coalesce(sum(case direction when 'CREDIT' then amount_in_cents else -amount_in_cents end), 0)::text
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
}

export async function expectRejects(
  promise: Promise<unknown>,
  matcher: (error: any) => boolean,
): Promise<void> {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  expect(matcher(caught)).toBe(true);
}

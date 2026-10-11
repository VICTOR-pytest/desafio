import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTestOrm, resetDatabase, testDatabaseName } from '../integration/support';

export interface TestAppOptions {
  env?: Record<string, string>;
  resetDb?: boolean;
}

export async function createApp(options: TestAppOptions = {}): Promise<INestApplication> {
  const overrides = { DB_NAME: testDatabaseName(), ...options.env };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );

  Object.assign(process.env, overrides);

  try {
    if (options.resetDb) {
      const orm = await createTestOrm();
      await resetDatabase(orm);
      await orm.close();
    }

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();

    app.enableShutdownHooks();
    await app.init();
    return app;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function sqsEnv(suffix: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SQS_ENABLED: 'true',
    SQS_ENDPOINT: process.env.SQS_ENDPOINT as string,
    SQS_AUTO_CREATE_QUEUES: 'true',
    SQS_WAGER_QUEUE: `e2e-wager-${suffix}.fifo`,
    SQS_WAGER_DLQ: `e2e-wager-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE: `e2e-events-${suffix}.fifo`,
    SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
    SQS_WAIT_TIME_SECONDS: '1',
    ...extra,
  };
}

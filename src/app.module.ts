import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetLedgerUseCase } from './application/get-ledger.use-case';
import { GetTransactionUseCase } from './application/get-transaction.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { OutboxPublisher } from './application/outbox-publisher';
import { Telemetry, UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { ReconcileAllWalletsUseCase } from './application/reconcile-all-wallets.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { ResolvePendingReferencesUseCase } from './application/resolve-pending-references.use-case';
import { WagerProcessor } from './domain/wager-processor/wager-processor';
import { readDatabaseSettings } from './infrastructure/config/env';
import { readSqsSettings, readWorkerSettings } from './infrastructure/config/sqs-env';
import { buildMikroOrmConfig } from './infrastructure/database/mikro-orm.config';
import { PostgresUnitOfWork } from './infrastructure/database/postgres-unit-of-work';
import { PostgresOutboxStore } from './infrastructure/database/repositories/postgres-outbox.repository';
import { PostgresPendingReferenceStore } from './infrastructure/database/repositories/postgres-pending-reference.store';
import { PostgresReconciliationStore } from './infrastructure/database/repositories/postgres-reconciliation.repository';
import { ApiExceptionFilter } from './infrastructure/http/api-exception.filter';
import {
  HEALTH_DEPENDENCIES,
  HealthController,
  HealthDependencies,
} from './infrastructure/http/health.controller';
import {
  METRICS_DEPENDENCIES,
  MetricsController,
  MetricsDependencies,
} from './infrastructure/http/metrics.controller';
import {
  LegacyWagerTransactionsController,
  ProvidersController,
  WageringTransactionsController,
} from './infrastructure/http/wager-transactions.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { MetricsRegistry } from './infrastructure/observability/metrics';
import { createSqsClient, QueueUrls, resolveQueues } from './infrastructure/sqs/sqs-queues';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { SqsWagerConsumer } from './infrastructure/sqs/sqs-wager-consumer';
import { IntervalWorker } from './infrastructure/workers/interval-worker';
import { ManagedWorkers, WorkersLifecycle } from './infrastructure/workers/workers.lifecycle';
import type { SQSClient } from '@aws-sdk/client-sqs';

export const TELEMETRY = Symbol('TELEMETRY');
const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
const SQS_RUNTIME = Symbol('SQS_RUNTIME');

interface SqsRuntime {
  client: SQSClient;
  urls: QueueUrls;
}

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => buildMikroOrmConfig(readDatabaseSettings()),
    }),
  ],
  controllers: [
    HealthController,
    MetricsController,
    WalletsController,
    WageringTransactionsController,
    LegacyWagerTransactionsController,
    ProvidersController,
  ],
  providers: [
    { provide: MetricsRegistry, useFactory: () => new MetricsRegistry() },
    {
      provide: TELEMETRY,
      inject: [MetricsRegistry],
      useFactory: (registry: MetricsRegistry): Telemetry => ({
        metrics: registry,
        logger: new JsonLogger(),
      }),
    },
    {
      provide: SQS_RUNTIME,
      useFactory: async (): Promise<SqsRuntime | null> => {
        const settings = readSqsSettings();

        if (!settings.enabled) {
          return null;
        }

        const client = createSqsClient(settings);
        return { client, urls: await resolveQueues(client, settings) };
      },
    },
    {
      provide: UNIT_OF_WORK,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new PostgresUnitOfWork(em),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, TELEMETRY],
      useFactory: (unitOfWork: UnitOfWork, telemetry: Telemetry) => {
        const workers = readWorkerSettings();

        return new ProcessWagerTransactionUseCase(
          unitOfWork,
          new WagerProcessor(),
          () => new Date(),
          telemetry,
          { ttlMs: workers.pendingTtlMs, baseBackoffMs: workers.pendingBaseBackoffMs },
        );
      },
    },
    {
      provide: OpenWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new OpenWalletUseCase(unitOfWork),
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWalletUseCase(unitOfWork),
    },
    {
      provide: GetTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetTransactionUseCase(unitOfWork),
    },
    {
      provide: GetLedgerUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetLedgerUseCase(unitOfWork),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, TELEMETRY],
      useFactory: (unitOfWork: UnitOfWork, telemetry: Telemetry) =>
        new ReconcileWalletUseCase(unitOfWork, telemetry),
    },
    {
      provide: HEALTH_DEPENDENCIES,
      inject: [EntityManager, SQS_RUNTIME],
      useFactory: (em: EntityManager, sqs: SqsRuntime | null): HealthDependencies => ({
        em,
        sqs: sqs ? { client: sqs.client, queueUrl: sqs.urls.wagerQueueUrl } : null,
      }),
    },
    {
      provide: METRICS_DEPENDENCIES,
      inject: [MetricsRegistry, EntityManager],
      useFactory: (registry: MetricsRegistry, em: EntityManager): MetricsDependencies => ({
        registry,
        outbox: new PostgresOutboxStore(em),
      }),
    },
    {
      provide: WorkersLifecycle,
      inject: [
        EntityManager,
        UNIT_OF_WORK,
        SQS_RUNTIME,
        TELEMETRY,
        ProcessWagerTransactionUseCase,
        ReconcileWalletUseCase,
      ],
      useFactory: (
        em: EntityManager,
        unitOfWork: UnitOfWork,
        sqs: SqsRuntime | null,
        telemetry: Telemetry,
        processWager: ProcessWagerTransactionUseCase,
        reconcile: ReconcileWalletUseCase,
      ) => {
        const settings = readWorkerSettings();
        const sqsSettings = readSqsSettings();
        const logger = telemetry.logger;
        const intervalWorkers: IntervalWorker[] = [];
        let consumer: SqsWagerConsumer | null = null;

        if ((settings.sqsConsumer || settings.outboxPublisher) && !sqs) {
          throw new Error('Os workers de SQS exigem SQS_ENABLED=true');
        }

        if (settings.sqsConsumer && sqs) {
          consumer = new SqsWagerConsumer(
            sqs.client,
            sqs.urls.wagerQueueUrl,
            sqs.urls.wagerDlqUrl,
            processWager,
            {
              waitTimeSeconds: sqsSettings.waitTimeSeconds,
              retryBaseSeconds: sqsSettings.retryBaseSeconds,
              retryMaxSeconds: sqsSettings.retryMaxSeconds,
            },
            telemetry,
          );
        }

        if (settings.outboxPublisher && sqs) {
          const publisher = new OutboxPublisher(
            new PostgresOutboxStore(em),
            new SqsEventPublisher(sqs.client, sqs.urls.eventsQueueUrl),
            {},
            () => new Date(),
            telemetry,
          );

          intervalWorkers.push(
            new IntervalWorker(
              'outbox-publisher',
              settings.outboxIntervalMs,
              async () => {
                for (let i = 0; i < 20; i++) {
                  const { published, failed } = await publisher.publishPending();
                  if (published + failed === 0) return;
                }
              },
              logger,
            ),
          );
        }

        if (settings.pendingReferences) {
          const resolver = new ResolvePendingReferencesUseCase(
            new PostgresPendingReferenceStore(em),
            unitOfWork,
            new WagerProcessor(),
            {
              baseBackoffMs: settings.pendingBaseBackoffMs,
              maxAttempts: settings.pendingMaxAttempts,
            },
            () => new Date(),
            telemetry,
          );

          intervalWorkers.push(
            new IntervalWorker(
              'pending-references',
              settings.pendingIntervalMs,
              () => resolver.runOnce(),
              logger,
            ),
          );
        }

        if (settings.reconciliation) {
          const all = new ReconcileAllWalletsUseCase(
            new PostgresReconciliationStore(em),
            reconcile,
            telemetry,
          );

          intervalWorkers.push(
            new IntervalWorker(
              'reconciliation',
              settings.reconciliationIntervalMs,
              () => all.runOnce(),
              logger,
            ),
          );
        }

        const managed: ManagedWorkers = { intervalWorkers, consumer };
        return new WorkersLifecycle(managed, telemetry);
      },
    },
    {
      provide: APP_FILTER,
      inject: [TELEMETRY],
      useFactory: (telemetry: Telemetry) => new ApiExceptionFilter(telemetry.logger),
    },
  ],
})
export class AppModule {}

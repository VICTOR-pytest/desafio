export interface SqsSettings {
  enabled: boolean;
  endpoint?: string;
  region: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  maxReceiveCount: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  autoCreateQueues: boolean;
}

export interface WorkerSettings {
  sqsConsumer: boolean;
  outboxPublisher: boolean;
  pendingReferences: boolean;
  reconciliation: boolean;
  outboxIntervalMs: number;
  pendingIntervalMs: number;
  reconciliationIntervalMs: number;
  pendingTtlMs: number;
  pendingMaxAttempts: number;
  pendingBaseBackoffMs: number;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw === 'true';
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min = 0,
): number {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} deve ser um inteiro maior ou igual a ${min}`);
  }

  return value;
}

export function readSqsSettings(env: NodeJS.ProcessEnv = process.env): SqsSettings {
  return {
    enabled: flag(env, 'SQS_ENABLED'),
    endpoint: env.SQS_ENDPOINT || undefined,
    region: env.AWS_REGION || 'us-east-1',
    wagerQueueName: env.SQS_WAGER_QUEUE || 'wager-transactions.fifo',
    wagerDlqName: env.SQS_WAGER_DLQ || 'wager-transactions-dlq.fifo',
    eventsQueueName: env.SQS_EVENTS_QUEUE || 'wager-events.fifo',
    maxReceiveCount: integer(env, 'SQS_MAX_RECEIVE_COUNT', 5, 1),
    visibilityTimeoutSeconds: integer(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30, 1),
    waitTimeSeconds: integer(env, 'SQS_WAIT_TIME_SECONDS', 10, 0),
    retryBaseSeconds: integer(env, 'SQS_RETRY_BASE_SECONDS', 2, 1),
    retryMaxSeconds: integer(env, 'SQS_RETRY_MAX_SECONDS', 300, 1),
    autoCreateQueues: flag(env, 'SQS_AUTO_CREATE_QUEUES'),
  };
}

export function readWorkerSettings(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSettings {
  return {
    sqsConsumer: flag(env, 'WORKER_SQS_CONSUMER'),
    outboxPublisher: flag(env, 'WORKER_OUTBOX_PUBLISHER'),
    pendingReferences: flag(env, 'WORKER_PENDING_REFERENCES'),
    reconciliation: flag(env, 'WORKER_RECONCILIATION'),
    outboxIntervalMs: integer(env, 'OUTBOX_POLL_INTERVAL_MS', 1000, 10),
    pendingIntervalMs: integer(env, 'PENDING_REFERENCE_INTERVAL_MS', 5000, 10),
    reconciliationIntervalMs: integer(env, 'RECONCILIATION_INTERVAL_MS', 300_000, 100),
    pendingTtlMs: integer(env, 'PENDING_REFERENCE_TTL_MS', 24 * 60 * 60 * 1000, 1),
    pendingMaxAttempts: integer(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 50, 1),
    pendingBaseBackoffMs: integer(env, 'PENDING_REFERENCE_BASE_BACKOFF_MS', 1000, 1),
  };
}

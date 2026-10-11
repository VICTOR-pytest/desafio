import {
  EventPublisher,
  NOOP_TELEMETRY,
  OutboxStore,
  Telemetry,
} from './ports';

export interface OutboxPublisherOptions {
  batchSize: number;
  leaseMs: number;
  maxAttempts: number | null;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface PublishSummary {
  published: number;
  failed: number;
}

const DEFAULT_OPTIONS: OutboxPublisherOptions = {
  batchSize: 50,
  leaseMs: 30_000,
  maxAttempts: null,
  baseBackoffMs: 1_000,
  maxBackoffMs: 5 * 60_000,
};

export class OutboxPublisher {
  private readonly options: OutboxPublisherOptions;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    options: Partial<OutboxPublisherOptions> = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async publishPending(): Promise<PublishSummary> {
    const batch = await this.store.claimBatch({
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
      now: this.clock(),
    });
    const summary: PublishSummary = { published: 0, failed: 0 };

    for (const message of batch) {
      try {
        await this.publisher.publish(message);
        await this.store.markPublished(message.id, this.clock());
        summary.published++;
        this.telemetry.metrics.increment('outbox_published_total', {
          eventType: message.eventType,
        });
      } catch (error) {
        const now = this.clock();
        const backoff = Math.min(
          this.options.baseBackoffMs * 2 ** Math.min(message.attempts - 1, 30),
          this.options.maxBackoffMs,
        );
        const giveUp =
          this.options.maxAttempts !== null &&
          message.attempts >= this.options.maxAttempts;
        const reason = error instanceof Error ? error.message : String(error);

        await this.store.markFailed(message.id, {
          error: reason,
          nextAttemptAt: new Date(now.getTime() + backoff),
          giveUp,
        });
        summary.failed++;
        this.telemetry.metrics.increment('outbox_publish_failures_total', {
          eventType: message.eventType,
          final: String(giveUp),
        });
        this.telemetry.logger[giveUp ? 'error' : 'warn']('outbox publish failed', {
          eventId: message.id,
          eventType: message.eventType,
          aggregateId: message.aggregateId,
          correlationId: message.correlationId,
          attempts: message.attempts,
          giveUp,
          error: reason,
        });
      }
    }

    return summary;
  }
}

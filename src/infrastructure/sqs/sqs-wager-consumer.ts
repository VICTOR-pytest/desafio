import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../../domain/domain-error';
import { IdempotencyConflictError } from '../../application/errors';
import { NOOP_TELEMETRY, Telemetry } from '../../application/ports';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { parseQueueMessage, PermanentMessageError } from './sqs-message-parser';

export interface ConsumerOptions {
  waitTimeSeconds: number;
  maxMessages: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export interface ConsumerHooks {
  beforeAcknowledge?: (message: Message) => Promise<void>;
}

const DEFAULT_OPTIONS: ConsumerOptions = {
  waitTimeSeconds: 10,
  maxMessages: 10,
  retryBaseSeconds: 2,
  retryMaxSeconds: 300,
};

export class SqsWagerConsumer {
  private readonly options: ConsumerOptions;
  private running = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly useCase: ProcessWagerTransactionUseCase,
    options: Partial<ConsumerOptions> = {},
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    private readonly hooks: ConsumerHooks = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
    this.loop = null;
  }

  async pollOnce(): Promise<number> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
      { abortSignal: this.abort?.signal },
    );

    for (const message of Messages) {
      try {
        await this.handle(message);
      } catch (error) {
        this.telemetry.logger.error('message handling interrupted', {
          messageId: message.MessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) {
          return;
        }

        this.telemetry.logger.error('sqs poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    let command;

    try {
      command = parseQueueMessage(message);
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        await this.deadLetter(message, error.reason, error.message);
        return;
      }

      throw error;
    }

    let result;

    try {
      result = await this.useCase.execute(command);
    } catch (error) {
      if (error instanceof DomainError) {
        await this.deadLetter(message, error.code, error.message);
      } else if (error instanceof IdempotencyConflictError) {
        await this.deadLetter(message, 'IDEMPOTENCY_CONFLICT', error.message);
      } else {
        await this.retryLater(message, error);
      }
      return;
    }

    await this.hooks.beforeAcknowledge?.(message);
    await this.delete(message);

    this.telemetry.metrics.increment('sqs_messages_total', {
      result: result.idempotentReplay ? 'duplicate' : 'processed',
    });
  }

  private async retryLater(message: Message, error: unknown): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const delay = Math.min(
      this.options.retryBaseSeconds * 2 ** Math.max(receiveCount - 1, 0),
      this.options.retryMaxSeconds,
    );

    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );

    this.telemetry.metrics.increment('sqs_retries_total');
    this.telemetry.logger.warn('transient failure, message will be retried', {
      messageId: message.MessageId,
      receiveCount,
      retryInSeconds: delay,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async deadLetter(
    message: Message,
    reason: string,
    detail: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          originalMessageId: {
            DataType: 'String',
            StringValue: message.MessageId ?? 'unknown',
          },
        },
      }),
    );
    await this.delete(message);

    this.telemetry.metrics.increment('sqs_dlq_total', { reason });
    this.telemetry.logger.error('message moved to dlq', {
      messageId: message.MessageId,
      reason,
      detail,
    });
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}

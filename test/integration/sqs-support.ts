import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { readSqsSettings, SqsSettings } from '../../src/infrastructure/config/sqs-env';
import { createSqsClient, ensureQueues, QueueUrls } from '../../src/infrastructure/sqs/sqs-queues';

export interface TestQueues {
  client: SQSClient;
  urls: QueueUrls;
  settings: SqsSettings;
}

let counter = 0;

export async function createTestQueues(
  overrides: Record<string, string> = {},
): Promise<TestQueues> {
  const suffix = `${Date.now()}-${++counter}`;
  const settings = readSqsSettings({
    SQS_ENABLED: 'true',
    SQS_ENDPOINT: process.env.SQS_ENDPOINT,
    AWS_REGION: process.env.AWS_REGION,
    SQS_WAGER_QUEUE: `wager-transactions-${suffix}.fifo`,
    SQS_WAGER_DLQ: `wager-transactions-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE: `wager-events-${suffix}.fifo`,
    SQS_AUTO_CREATE_QUEUES: 'true',
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
    ...overrides,
  });
  const client = createSqsClient(settings);

  return { client, settings, urls: await ensureQueues(client, settings) };
}

export interface WagerMessage {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  roundId: string;
  type: string;
  amount: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  walletId?: string;
}

export async function sendWager(
  queues: TestQueues,
  payload: Record<string, unknown>,
  options: {
    attributeProvider?: string | null;
    groupId?: string;
    dedupId?: string;
    rawBody?: string;
  } = {},
): Promise<string> {
  const attributeProvider =
    options.attributeProvider === undefined
      ? (payload.providerId as string)
      : options.attributeProvider;

  const { MessageId } = await queues.client.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.wagerQueueUrl,
      MessageBody: options.rawBody ?? JSON.stringify(payload),
      MessageGroupId:
        options.groupId ??
        (typeof payload.playerId === 'string' ? payload.playerId : 'group'),
      MessageDeduplicationId:
        options.dedupId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      MessageAttributes: attributeProvider
        ? { providerId: { DataType: 'String', StringValue: attributeProvider } }
        : undefined,
    }),
  );

  return MessageId as string;
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condição não atendida em ${timeoutMs}ms`);
}

export async function queueDepth(
  client: SQSClient,
  queueUrl: string,
): Promise<{ visible: number; inFlight: number; delayed: number }> {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );

  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

export async function isEmpty(client: SQSClient, queueUrl: string): Promise<boolean> {
  const depth = await queueDepth(client, queueUrl);
  return depth.visible + depth.inFlight + depth.delayed === 0;
}

export async function receiveAll(
  client: SQSClient,
  queueUrl: string,
  expected: number,
  timeoutMs = 15_000,
  acknowledge = false,
): Promise<Message[]> {
  const collected: Message[] = [];

  await waitFor(async () => {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
        VisibilityTimeout: 60,
      }),
    );

    for (const message of Messages) {
      if (acknowledge) {
        await client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }

    collected.push(...Messages);
    return collected.length >= expected;
  }, timeoutMs, 50);

  return collected;
}

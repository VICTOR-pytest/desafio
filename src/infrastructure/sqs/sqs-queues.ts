import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SqsSettings } from '../config/sqs-env';

export interface QueueUrls {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
  });
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );

  if (!Attributes?.QueueArn) {
    throw new Error(`Fila ${queueUrl} sem ARN`);
  }

  return Attributes.QueueArn;
}

async function createFifo(
  client: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...attributes },
    }),
  );

  if (!QueueUrl) {
    throw new Error(`Não foi possível criar a fila ${name}`);
  }

  return QueueUrl;
}

export async function ensureQueues(
  client: SQSClient,
  settings: SqsSettings,
): Promise<QueueUrls> {
  const wagerDlqUrl = await createFifo(client, settings.wagerDlqName);
  const deadLetterTargetArn = await queueArn(client, wagerDlqUrl);
  const wagerQueueUrl = await createFifo(client, settings.wagerQueueName, {
    VisibilityTimeout: String(settings.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn,
      maxReceiveCount: settings.maxReceiveCount,
    }),
  });
  const eventsQueueUrl = await createFifo(client, settings.eventsQueueName);

  return { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
}

export async function resolveQueues(
  client: SQSClient,
  settings: SqsSettings,
): Promise<QueueUrls> {
  if (settings.autoCreateQueues) {
    return ensureQueues(client, settings);
  }

  const urlOf = async (name: string) => {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));

    if (!QueueUrl) {
      throw new Error(`Fila ${name} não encontrada`);
    }

    return QueueUrl;
  };

  return {
    wagerQueueUrl: await urlOf(settings.wagerQueueName),
    wagerDlqUrl: await urlOf(settings.wagerDlqName),
    eventsQueueUrl: await urlOf(settings.eventsQueueName),
  };
}

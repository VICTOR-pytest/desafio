import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { toIntegrationEvent } from '../../application/events';
import { ClaimedOutboxMessage, EventPublisher } from '../../application/ports';

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: ClaimedOutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(toIntegrationEvent(message)),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}

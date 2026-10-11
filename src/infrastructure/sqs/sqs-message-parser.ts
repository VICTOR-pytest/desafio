import type { Message } from '@aws-sdk/client-sqs';
import { DomainError } from '../../domain/domain-error';
import { ProcessWagerCommand } from '../../application/process-wager-transaction.use-case';
import {
  optionalString,
  parseTransactionFields,
} from '../../application/transaction-input';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export class PermanentMessageError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export function parseQueueMessage(message: Message): ProcessWagerCommand {
  const messageId = message.MessageId;

  if (!messageId) {
    throw new PermanentMessageError('MISSING_MESSAGE_ID', 'Mensagem sem MessageId');
  }

  let body: unknown;

  try {
    body = JSON.parse(message.Body ?? '');
  } catch {
    throw new PermanentMessageError('INVALID_JSON', 'O corpo da mensagem não é JSON válido');
  }

  const attributeProvider = message.MessageAttributes?.providerId?.StringValue;

  if (!attributeProvider) {
    throw new PermanentMessageError(
      'PROVIDER_ATTRIBUTE_MISSING',
      'O atributo providerId é obrigatório',
    );
  }

  try {
    const { fields, data } = parseTransactionFields(body, [
      'idempotencyKey',
      'correlationId',
    ]);

    if (fields.provider !== attributeProvider) {
      throw new PermanentMessageError(
        'PROVIDER_IDENTITY_MISMATCH',
        'O providerId do corpo difere do atributo da mensagem',
      );
    }

    return {
      ...fields,
      idempotencyKey:
        optionalString(data, 'idempotencyKey') ??
        `queue:${fields.provider}:${fields.externalTransactionId}`,
      correlationId: optionalString(data, 'correlationId') ?? messageId,
      causationId: messageId,
      inbox: {
        source: WAGER_CONSUMER_NAME,
        messageId,
        payload: body as Record<string, unknown>,
      },
    };
  } catch (error) {
    if (error instanceof DomainError) {
      throw new PermanentMessageError('INVALID_MESSAGE', error.message);
    }

    throw error;
  }
}

import type { Message } from '@aws-sdk/client-sqs';
import {
  parseQueueMessage,
  PermanentMessageError,
  WAGER_CONSUMER_NAME,
} from './sqs-message-parser';

const body = {
  providerId: 'prov-1',
  externalTransactionId: 'ext-1',
  playerId: 'pl-1',
  roundId: 'r-1',
  type: 'BET',
  amount: { amount: '10.00', currency: 'BRL' },
};

const message = (overrides: Partial<Message> = {}, content: unknown = body): Message => ({
  MessageId: 'm-1',
  Body: JSON.stringify(content),
  MessageAttributes: { providerId: { DataType: 'String', StringValue: 'prov-1' } },
  ...overrides,
});

const reasonOf = (build: () => unknown): string => {
  try {
    build();
  } catch (error) {
    return (error as PermanentMessageError).reason;
  }
  return 'no-error';
};

describe('parseQueueMessage', () => {
  it('converte a mensagem em comando com inbox, correlação e causalidade', () => {
    expect(parseQueueMessage(message())).toMatchObject({
      provider: 'prov-1',
      externalTransactionId: 'ext-1',
      amount: { amount: '10.00', currency: 'BRL' },
      idempotencyKey: 'queue:prov-1:ext-1',
      correlationId: 'm-1',
      causationId: 'm-1',
      inbox: { source: WAGER_CONSUMER_NAME, messageId: 'm-1' },
    });
  });

  it('usa idempotencyKey e correlationId informados no corpo', () => {
    const command = parseQueueMessage(
      message({}, { ...body, idempotencyKey: 'k-9', correlationId: 'c-9' }),
    );

    expect(command.idempotencyKey).toBe('k-9');
    expect(command.correlationId).toBe('c-9');
  });

  it('aceita o formato legado de valor e moeda separados', () => {
    expect(
      parseQueueMessage(message({}, { ...body, amount: '5.00', currency: 'BRL' })).amount,
    ).toEqual({ amount: '5.00', currency: 'BRL' });
  });

  it('rejeita permanentemente quando o provedor do corpo difere do atributo', () => {
    expect(reasonOf(() => parseQueueMessage(message({}, { ...body, providerId: 'outro' })))).toBe(
      'PROVIDER_IDENTITY_MISMATCH',
    );
  });

  it('rejeita permanentemente sem atributo providerId', () => {
    expect(reasonOf(() => parseQueueMessage(message({ MessageAttributes: {} })))).toBe(
      'PROVIDER_ATTRIBUTE_MISSING',
    );
  });

  it('rejeita permanentemente JSON inválido, mensagem sem id e corpo inválido', () => {
    expect(reasonOf(() => parseQueueMessage(message({ Body: '{x' })))).toBe('INVALID_JSON');
    expect(reasonOf(() => parseQueueMessage(message({ MessageId: undefined })))).toBe(
      'MISSING_MESSAGE_ID',
    );
    expect(reasonOf(() => parseQueueMessage(message({}, { ...body, extra: 1 })))).toBe(
      'INVALID_MESSAGE',
    );
    expect(reasonOf(() => parseQueueMessage(message({}, { ...body, amount: 10 })))).toBe(
      'INVALID_MESSAGE',
    );
  });
});

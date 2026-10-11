import { DomainError } from '../domain/domain-error';
import { ProcessWagerCommand } from './process-wager-transaction.use-case';

type Body = Record<string, unknown>;

export type TransactionFields = Omit<
  ProcessWagerCommand,
  'idempotencyKey' | 'correlationId' | 'causationId' | 'inbox'
>;

const ALLOWED_FIELDS = [
  'providerId',
  'provider',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'type',
  'amount',
  'currency',
  'referenceExternalTransactionId',
];

export function invalidRequest(message: string): never {
  throw new DomainError('INVALID_REQUEST', message);
}

export function asObject(body: unknown, allowed: string[]): Body {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    invalidRequest('O corpo da requisição deve ser um objeto JSON');
  }

  const unknown = Object.keys(body as Body).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    invalidRequest(`Campos não permitidos: ${unknown.join(', ')}`);
  }

  return body as Body;
}

export function requiredString(body: Body, field: string): string {
  const value = body[field];

  if (typeof value !== 'string' || !value.trim()) {
    invalidRequest(`${field} é obrigatório e deve ser uma string`);
  }

  return value as string;
}

export function optionalString(body: Body, field: string): string | undefined {
  return body[field] === undefined ? undefined : requiredString(body, field);
}

function parseMoney(data: Body): { amount: string; currency: string } {
  const raw = data.amount;

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const money = raw as Body;

    if (data.currency !== undefined) {
      invalidRequest('Informe a moeda dentro de amount ou em currency, não em ambos');
    }

    return {
      amount: requiredString(asObject(money, ['amount', 'currency']), 'amount'),
      currency: requiredString(money, 'currency'),
    };
  }

  return {
    amount: requiredString(data, 'amount'),
    currency: requiredString(data, 'currency'),
  };
}

export function parseTransactionFields(
  body: unknown,
  extraAllowed: string[] = [],
): { fields: TransactionFields; data: Body } {
  const data = asObject(body, [...ALLOWED_FIELDS, ...extraAllowed]);

  if (data.providerId !== undefined && data.provider !== undefined) {
    invalidRequest('Informe providerId ou provider, não ambos');
  }

  const provider =
    data.providerId !== undefined
      ? requiredString(data, 'providerId')
      : requiredString(data, 'provider');

  return {
    data,
    fields: {
      provider,
      externalTransactionId: requiredString(data, 'externalTransactionId'),
      playerId: requiredString(data, 'playerId'),
      walletId: optionalString(data, 'walletId'),
      roundId: requiredString(data, 'roundId'),
      type: requiredString(data, 'type') as ProcessWagerCommand['type'],
      amount: parseMoney(data),
      referenceExternalTransactionId: optionalString(
        data,
        'referenceExternalTransactionId',
      ),
    },
  };
}

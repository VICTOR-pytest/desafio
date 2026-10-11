import { DomainError } from '../../domain/domain-error';
import { OpenWalletCommand } from '../../application/open-wallet.use-case';
import { ProcessWagerCommand } from '../../application/process-wager-transaction.use-case';
import {
  asObject,
  invalidRequest,
  parseTransactionFields,
  requiredString,
} from '../../application/transaction-input';

export function parseWagerTransactionBody(
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId?: string,
): ProcessWagerCommand {
  if (!idempotencyKey?.trim()) {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'O cabeçalho Idempotency-Key é obrigatório',
    );
  }

  return {
    ...parseTransactionFields(body).fields,
    idempotencyKey: idempotencyKey.trim(),
    correlationId,
  };
}

export function parseOpenWalletBody(
  body: unknown,
  correlationId?: string,
): OpenWalletCommand {
  const data = asObject(body, [
    'playerId',
    'currency',
    'openingBalance',
    'initialBalance',
  ]);

  if (data.initialBalance !== undefined) {
    if (data.openingBalance !== undefined || data.currency !== undefined) {
      invalidRequest('Use apenas initialBalance: { amount, currency }');
    }

    const balance = asObject(data.initialBalance, ['amount', 'currency']);
    const currency = requiredString(balance, 'currency');

    return {
      playerId: requiredString(data, 'playerId'),
      currency,
      openingBalance: { amount: requiredString(balance, 'amount'), currency },
      correlationId,
    };
  }

  const currency = requiredString(data, 'currency');

  return {
    playerId: requiredString(data, 'playerId'),
    currency,
    openingBalance: {
      amount: requiredString(data, 'openingBalance'),
      currency,
    },
    correlationId,
  };
}

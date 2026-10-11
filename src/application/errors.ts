export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('A chave de idempotência já foi usada com um payload diferente');
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Já existe uma carteira ${currency} para o jogador ${playerId}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Carteira ${currency} do jogador ${playerId} não encontrada`);
    this.name = 'WalletNotFoundError';
  }
}

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class WalletOpeningCurrencyError extends Error {
  constructor() {
    super('A moeda do saldo inicial deve ser a mesma da carteira');
    this.name = 'WalletOpeningCurrencyError';
  }
}

export class TransactionNotFoundError extends Error {
  constructor() {
    super('Transação não encontrada');
    this.name = 'TransactionNotFoundError';
  }
}

export class WalletIdNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Carteira ${walletId} não encontrada`);
    this.name = 'WalletIdNotFoundError';
  }
}

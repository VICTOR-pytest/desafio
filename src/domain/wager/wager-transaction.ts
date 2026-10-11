import { DomainError } from '../domain-error';
import { Money } from '../money/money';
import { FailureCode } from './failure-code';

export enum WagerTransactionType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export type ExternalWagerTransactionType = Exclude<
  WagerTransactionType,
  WagerTransactionType.OPENING
>;

export const INTERNAL_PROVIDER = 'SYSTEM';

const TERMINAL_STATUSES = new Set([
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);

const EXTERNAL_TYPES = new Set<string>([
  WagerTransactionType.BET,
  WagerTransactionType.WIN,
  WagerTransactionType.LOSS,
  WagerTransactionType.REFUND,
  WagerTransactionType.ROLLBACK,
]);

const MAX_LENGTHS = {
  provider: 64,
  externalTransactionId: 128,
  playerId: 255,
  roundId: 128,
} as const;

export interface ExternalWagerTransactionProps {
  id: string;
  provider: string;
  externalTransactionId: string;
  playerId: string;
  roundId: string;
  type: ExternalWagerTransactionType;
  amount: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  openingBalance: Money;
  createdAt?: Date;
}

export interface WagerTransactionSnapshot {
  id: string;
  provider: string;
  externalTransactionId: string;
  playerId: string;
  roundId: string;
  type: WagerTransactionType;
  amount: Money;
  walletId: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  createdAt: Date;
  processedAt: Date | null;
}

export class WagerTransaction {
  private constructor(private state: WagerTransactionSnapshot) {}

  static receive(props: ExternalWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_TYPES.has(props.type)) {
      throw new DomainError(
        'INVALID_TRANSACTION_TYPE',
        'Tipo de transação não aceito como entrada externa',
      );
    }

    const reference = props.referenceExternalTransactionId?.trim() || null;
    const needsReference =
      props.type === WagerTransactionType.REFUND ||
      props.type === WagerTransactionType.ROLLBACK;

    if (needsReference && !reference) {
      throw new DomainError(
        'REFERENCE_REQUIRED',
        'REFUND e ROLLBACK exigem uma transação de referência',
      );
    }

    if (!needsReference && reference) {
      throw new DomainError(
        'REFERENCE_NOT_ALLOWED',
        'Apenas REFUND e ROLLBACK aceitam transação de referência',
      );
    }

    return WagerTransaction.build({
      id: props.id,
      provider: props.provider,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      roundId: props.roundId,
      type: props.type,
      amount: props.amount,
      walletId: null,
      referenceExternalTransactionId: reference,
      referenceTransactionId: null,
      status: WagerTransactionStatus.PENDING,
      failureCode: null,
      createdAt: props.createdAt ?? new Date(),
      processedAt: null,
    });
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    return WagerTransaction.build({
      id: props.id,
      provider: INTERNAL_PROVIDER,
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      roundId: 'OPENING',
      type: WagerTransactionType.OPENING,
      amount: props.openingBalance,
      walletId: props.walletId,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: WagerTransactionStatus.PENDING,
      failureCode: null,
      createdAt: props.createdAt ?? new Date(),
      processedAt: null,
    });
  }

  static rehydrate(snapshot: WagerTransactionSnapshot): WagerTransaction {
    return WagerTransaction.build({ ...snapshot });
  }

  private static build(state: WagerTransactionSnapshot): WagerTransaction {
    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      const value = state[field as keyof typeof MAX_LENGTHS];

      if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new DomainError(
          'INVALID_TRANSACTION',
          `${field} é obrigatório e deve ter no máximo ${max} caracteres`,
        );
      }
    }

    if (!state.id?.trim()) {
      throw new DomainError('INVALID_TRANSACTION', 'ID da transação é obrigatório');
    }

    const isOpening = state.type === WagerTransactionType.OPENING;

    if (state.amount.isNegative() || (!isOpening && state.amount.isZero())) {
      throw new DomainError(
        'INVALID_AMOUNT',
        'O valor da transação deve ser positivo',
      );
    }

    return new WagerTransaction(state);
  }

  get id(): string {
    return this.state.id;
  }

  get provider(): string {
    return this.state.provider;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string {
    return this.state.roundId;
  }

  get type(): WagerTransactionType {
    return this.state.type;
  }

  get amount(): Money {
    return this.state.amount;
  }

  get walletId(): string | null {
    return this.state.walletId;
  }

  get referenceExternalTransactionId(): string | null {
    return this.state.referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | null {
    return this.state.referenceTransactionId;
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get failureCode(): FailureCode | null {
    return this.state.failureCode;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get processedAt(): Date | null {
    return this.state.processedAt;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.state.status);
  }

  bindWallet(walletId: string): void {
    if (this.state.walletId && this.state.walletId !== walletId) {
      throw new DomainError(
        'WALLET_ALREADY_BOUND',
        'A transação já está associada a outra carteira',
      );
    }

    this.state = { ...this.state, walletId };
  }

  bindReference(referenceTransactionId: string): void {
    this.assertOpen();
    this.state = { ...this.state, referenceTransactionId };
  }

  markPendingReference(): void {
    this.assertOpen();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.PENDING_REFERENCE,
    };
  }

  markProcessed(now: Date = new Date()): void {
    this.assertOpen();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.PROCESSED,
      failureCode: null,
      processedAt: now,
    };
  }

  markRejected(failureCode: FailureCode, now: Date = new Date()): void {
    this.assertOpen();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.REJECTED,
      failureCode,
      processedAt: now,
    };
  }

  markFailed(failureCode: FailureCode, now: Date = new Date()): void {
    this.assertOpen();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.FAILED,
      failureCode,
      processedAt: now,
    };
  }

  toSnapshot(): WagerTransactionSnapshot {
    return { ...this.state };
  }

  private assertOpen(): void {
    if (this.isTerminal()) {
      throw new DomainError(
        'INVALID_TRANSITION',
        `Transação em estado terminal (${this.state.status}) não pode ser alterada`,
      );
    }
  }
}

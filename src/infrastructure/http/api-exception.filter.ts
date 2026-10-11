import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  RetryableError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletIdNotFoundError,
  WalletNotFoundError,
  WalletOpeningCurrencyError,
} from '../../application/errors';
import type { Logger } from '../../application/ports';
import { DomainError } from '../../domain/domain-error';

interface ErrorResponse {
  status: HttpStatus;
  code: string;
  message: string;
}

function describe(error: unknown): ErrorResponse | null {
  if (error instanceof DomainError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof IdempotencyConflictError) {
    return { status: HttpStatus.CONFLICT, code: 'IDEMPOTENCY_CONFLICT', message: error.message };
  }

  if (error instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, code: 'WALLET_ALREADY_EXISTS', message: error.message };
  }

  if (
    error instanceof WalletNotFoundError ||
    error instanceof WalletIdNotFoundError
  ) {
    return { status: HttpStatus.NOT_FOUND, code: 'WALLET_NOT_FOUND', message: error.message };
  }

  if (error instanceof TransactionNotFoundError) {
    return { status: HttpStatus.NOT_FOUND, code: 'TRANSACTION_NOT_FOUND', message: error.message };
  }

  if (error instanceof WalletOpeningCurrencyError) {
    return { status: HttpStatus.BAD_REQUEST, code: 'CURRENCY_MISMATCH', message: error.message };
  }

  if (error instanceof RetryableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'TEMPORARILY_UNAVAILABLE',
      message: 'Conflito de concorrência; tente novamente com a mesma Idempotency-Key',
    };
  }

  return null;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();

    if (error instanceof HttpException) {
      response.status(error.getStatus()).json({
        code: 'HTTP_ERROR',
        message: error.message,
      });
      return;
    }

    const known = describe(error);

    if (known) {
      response
        .status(known.status)
        .json({ code: known.code, message: known.message });
      return;
    }

    this.logger.error('unhandled error', {
      error: error instanceof Error ? error.stack : String(error),
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno',
    });
  }
}

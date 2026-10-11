import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { GetTransactionUseCase } from '../../application/get-transaction.use-case';
import {
  ProcessWagerResult,
  ProcessWagerTransactionUseCase,
} from '../../application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { resolveCorrelationId } from './correlation';
import { parseWagerTransactionBody } from './request-parsers';

type Req_ = Parameters<typeof resolveCorrelationId>[0];
type Res_ = Parameters<typeof resolveCorrelationId>[1] & { status(code: number): unknown };

function statusFor(result: ProcessWagerResult): number {
  if (result.status === WagerTransactionStatus.REJECTED) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }

  if (result.status === WagerTransactionStatus.PENDING_REFERENCE) {
    return HttpStatus.ACCEPTED;
  }

  return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
}

async function submit(
  useCase: ProcessWagerTransactionUseCase,
  body: unknown,
  idempotencyKey: string | undefined,
  request: Req_,
  response: Res_,
) {
  const correlationId = resolveCorrelationId(request, response);
  const result = await useCase.execute(
    parseWagerTransactionBody(body, idempotencyKey, correlationId),
  );

  response.status(statusFor(result));
  return result;
}

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Post()
  receive(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Req_,
    @Res({ passthrough: true }) response: Res_,
  ) {
    return submit(this.processWager, body, idempotencyKey, request, response);
  }

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }
}

@Controller('wager-transactions')
export class LegacyWagerTransactionsController {
  constructor(private readonly processWager: ProcessWagerTransactionUseCase) {}

  @Post()
  receive(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Req_,
    @Res({ passthrough: true }) response: Res_,
  ) {
    return submit(this.processWager, body, idempotencyKey, request, response);
  }
}

@Controller('providers')
export class ProvidersController {
  constructor(private readonly getTransaction: GetTransactionUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}

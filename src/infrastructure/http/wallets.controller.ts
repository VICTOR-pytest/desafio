import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { DomainError } from '../../domain/domain-error';
import { GetLedgerUseCase } from '../../application/get-ledger.use-case';
import { GetWalletUseCase } from '../../application/get-wallet.use-case';
import { OpenWalletUseCase } from '../../application/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case';
import { resolveCorrelationId } from './correlation';
import { parseOpenWalletBody } from './request-parsers';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  open(
    @Body() body: unknown,
    @Req() request: Parameters<typeof resolveCorrelationId>[0],
    @Res({ passthrough: true }) response: Parameters<typeof resolveCorrelationId>[1],
  ) {
    const correlationId = resolveCorrelationId(request, response);
    return this.openWallet.execute(parseOpenWalletBody(body, correlationId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);

    if (limit !== undefined && !/^\d+$/.test(limit)) {
      throw new DomainError('INVALID_LIMIT', 'limit deve ser um inteiro positivo');
    }

    return this.getLedger.execute(walletId, cursor || null, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(walletId, 'MANUAL');
  }

  @Get(':playerId/:currency')
  getByPlayer(
    @Param('playerId') playerId: string,
    @Param('currency') currency: string,
  ) {
    return this.getWallet.execute(playerId, currency);
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.getWallet.byId(walletId);
  }
}

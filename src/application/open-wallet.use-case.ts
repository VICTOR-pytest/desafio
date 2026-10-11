import { randomUUID } from 'node:crypto';
import { Money, MoneyProps } from '../domain/money/money';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { WagerProcessor } from '../domain/wager-processor/wager-processor';
import { Wallet } from '../domain/wallet/wallet';
import { hashPayload } from './canonical-hash';
import {
  WalletAlreadyExistsError,
  WalletOpeningCurrencyError,
} from './errors';
import { balanceChangedEvent } from './events';
import { UnitOfWork } from './ports';
import { withBoundedRetry } from './retry';

export interface OpenWalletCommand {
  playerId: string;
  currency: string;
  openingBalance: MoneyProps;
  correlationId?: string;
}

export interface OpenWalletResult {
  walletId: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerProcessor = new WagerProcessor(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const openingBalance = Money.from(command.openingBalance);

    if (openingBalance.currency !== command.currency) {
      throw new WalletOpeningCurrencyError();
    }

    return withBoundedRetry(() =>
      this.unitOfWork.run(async (context) => {
        const now = this.clock();
        const existing = await context.wallets.lockByPlayerAndCurrency(
          command.playerId,
          command.currency,
        );

        if (existing) {
          throw new WalletAlreadyExistsError(command.playerId, command.currency);
        }

        const wallet = Wallet.create({
          id: randomUUID(),
          playerId: command.playerId,
          currency: command.currency,
        });
        const transaction = WagerTransaction.opening({
          id: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          openingBalance,
          createdAt: now,
        });
        const entry = this.processor.process(transaction, wallet);

        if (!entry) {
          throw new Error('OPENING deve gerar um lançamento');
        }

        const summary = {
          walletId: wallet.id,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };

        await context.wallets.insert(wallet);
        await context.transactions.insert(transaction, {
          idempotencyKey: transaction.externalTransactionId,
          payloadHash: hashPayload({
            playerId: command.playerId,
            currency: command.currency,
            openingBalance: command.openingBalance.amount,
          }),
          responseSnapshot: {
            status: transaction.status,
            failureCode: null,
            wallet: summary,
          },
          correlationId: command.correlationId ?? null,
          pending: null,
        });
        await context.ledger.insert(entry);

        if (entry.amount.isPositive()) {
          await context.outbox.insert(
            balanceChangedEvent(wallet, entry, {
              correlationId: command.correlationId ?? null,
              causationId: transaction.id,
              now,
            }),
          );
        }

        return {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      }),
    );
  }
}

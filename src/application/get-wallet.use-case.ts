import { MoneyProps } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import { WalletIdNotFoundError, WalletNotFoundError } from './errors';
import { UnitOfWork } from './ports';
import { isUuid } from './uuid';

export interface WalletView {
  walletId: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
}

function toView(wallet: Wallet): WalletView {
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export class GetWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(playerId: string, currency: string): Promise<WalletView> {
    return this.unitOfWork.run(async (context) => {
      const wallet = await context.wallets.findByPlayerAndCurrency(
        playerId,
        currency,
      );

      if (!wallet) {
        throw new WalletNotFoundError(playerId, currency);
      }

      return toView(wallet);
    });
  }

  byId(walletId: string): Promise<WalletView> {
    if (!isUuid(walletId)) {
      return Promise.reject(new WalletIdNotFoundError(walletId));
    }

    return this.unitOfWork.run(async (context) => {
      const wallet = await context.wallets.findById(walletId);

      if (!wallet) {
        throw new WalletIdNotFoundError(walletId);
      }

      return toView(wallet);
    });
  }
}

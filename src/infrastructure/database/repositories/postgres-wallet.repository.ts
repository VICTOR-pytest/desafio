import type { EntityManager } from '@mikro-orm/postgresql';
import { RetryableError } from '../../../application/errors';
import { WalletRepository } from '../../../application/ports';
import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { queryRows, runStatement } from './sql';

const COLUMNS = `id, player_id, currency, balance_in_cents::text as balance_in_cents, version::text as version`;

export class PostgresWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  findById(walletId: string): Promise<Wallet | null> {
    return this.select('id = ?', [walletId], '');
  }

  lockById(walletId: string): Promise<Wallet | null> {
    return this.select('id = ?', [walletId], ' for update');
  }

  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    return this.select('player_id = ? and currency = ?', [playerId, currency], '');
  }

  lockByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    return this.select(
      'player_id = ? and currency = ?',
      [playerId, currency],
      ' for update',
    );
  }

  async insert(wallet: Wallet): Promise<void> {
    const now = new Date().toISOString();

    await runStatement(
      this.em,
      `insert into wallets (id, player_id, currency, balance_in_cents, version, created_at, updated_at)
       values (?, ?, ?, ?::bigint, ?::bigint, ?::timestamptz, ?::timestamptz)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toCents().toString(),
        wallet.version,
        now,
        now,
      ],
    );
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await runStatement(
      this.em,
      `update wallets
       set balance_in_cents = ?::bigint, version = ?::bigint, updated_at = ?::timestamptz
       where id = ? and version = ?::bigint`,
      [
        wallet.balance.toCents().toString(),
        wallet.version,
        new Date().toISOString(),
        wallet.id,
        expectedVersion,
      ],
    );

    if (affected !== 1) {
      throw new RetryableError(
        `Versão da carteira ${wallet.id} mudou durante a operação`,
      );
    }
  }

  private async select(
    condition: string,
    params: unknown[],
    suffix: string,
  ): Promise<Wallet | null> {
    const [row] = await queryRows(
      this.em,
      `select ${COLUMNS} from wallets where ${condition}${suffix}`,
      params,
    );

    if (!row) {
      return null;
    }

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.fromCents(BigInt(row.balance_in_cents), row.currency),
      version: Number(row.version),
    });
  }
}

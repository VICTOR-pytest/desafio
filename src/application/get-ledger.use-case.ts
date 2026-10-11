import { DomainError } from '../domain/domain-error';
import { WalletIdNotFoundError } from './errors';
import { LedgerPageItem, UnitOfWork } from './ports';
import { isUuid } from './uuid';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerPage {
  items: Array<Omit<LedgerPageItem, 'createdAt'> & { createdAt: string }>;
  nextCursor: string | null;
}

export function encodeCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString('base64url');
}

function parseCursor(cursor: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const valid =
      parsed?.v === 1 && typeof parsed.s === 'string' && /^\d+$/.test(parsed.s);

    return valid ? parsed.s : null;
  } catch {
    return null;
  }
}

export function decodeCursor(cursor: string): string {
  const sequence = parseCursor(cursor);

  if (sequence === null) {
    throw new DomainError('INVALID_CURSOR', 'Cursor inválido');
  }

  return sequence;
}

export class GetLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    walletId: string,
    cursor: string | null,
    limit: number = DEFAULT_LEDGER_LIMIT,
  ): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new DomainError(
        'INVALID_LIMIT',
        `limit deve ser um inteiro entre 1 e ${MAX_LEDGER_LIMIT}`,
      );
    }

    const after = cursor ? decodeCursor(cursor) : null;

    if (!isUuid(walletId)) {
      throw new WalletIdNotFoundError(walletId);
    }

    return this.unitOfWork.run(async (context) => {
      if (!(await context.wallets.findById(walletId))) {
        throw new WalletIdNotFoundError(walletId);
      }

      const rows = await context.ledger.listByWallet(walletId, after, limit + 1);
      const page = rows.slice(0, limit);

      return {
        items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextCursor:
          rows.length > limit ? encodeCursor(page[page.length - 1].sequence) : null,
      };
    });
  }
}

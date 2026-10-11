import type { EntityManager } from '@mikro-orm/postgresql';

export type Row = Record<string, any>;

export const timestampColumn = (column: string, alias = column): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${alias}`;

export function parseTimestamp(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export async function queryRows(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  return (await em.execute(sql, params as any[], 'all')) as Row[];
}

export async function runStatement(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = (await em.execute(sql, params as any[], 'run')) as {
    affectedRows?: number;
  };
  return result.affectedRows ?? 0;
}

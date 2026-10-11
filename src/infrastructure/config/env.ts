import { config } from 'dotenv';

config({ quiet: true });

export interface DatabaseSettings {
  host: string;
  port: number;
  dbName: string;
  user: string;
  password: string;
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);

  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`${name} deve ser uma porta TCP válida`);
  }

  return port;
}

export function readDatabaseSettings(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseSettings {
  const password = env.DB_PASSWORD;

  if (!password) {
    throw new Error('DB_PASSWORD é obrigatória');
  }

  return {
    host: env.DB_HOST || '127.0.0.1',
    port: parsePort('DB_PORT', env.DB_PORT || '5433'),
    dbName: env.DB_NAME || 'jungle_wagering',
    user: env.DB_USER || 'jungle_app',
    password,
  };
}

export function readServerPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort('PORT', env.PORT || '3001');
}

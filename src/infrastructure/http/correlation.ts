import { randomUUID } from 'node:crypto';

interface HeaderReader {
  headers: Record<string, string | string[] | undefined>;
}

interface HeaderWriter {
  setHeader(name: string, value: string): unknown;
}

export function resolveCorrelationId(request: HeaderReader, response: HeaderWriter): string {
  const raw = request.headers['x-correlation-id'];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  const id = supplied?.trim() && supplied.length <= 128 ? supplied.trim() : randomUUID();

  response.setHeader('X-Correlation-Id', id);
  return id;
}

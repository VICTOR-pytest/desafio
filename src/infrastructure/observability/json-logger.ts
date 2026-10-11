import { LogFields, Logger } from '../../application/ports';

const REDACTED_KEYS = /password|secret|token|authorization|credential|api[-_]?key/i;

function sanitize(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, REDACTED_KEYS.test(key) ? '[REDACTED]' : value]),
  );
}

export class JsonLogger implements Logger {
  constructor(
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(`${line}\n`),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  info(message: string, fields: LogFields = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit('error', message, fields);
  }

  private emit(level: string, message: string, fields: LogFields): void {
    this.write(
      JSON.stringify({
        timestamp: this.clock().toISOString(),
        level,
        message,
        ...sanitize(fields),
      }),
    );
  }
}

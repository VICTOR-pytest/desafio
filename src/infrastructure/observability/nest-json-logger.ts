import { LoggerService } from '@nestjs/common';
import { Logger } from '../../application/ports';

export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error(String(message), { context: rest.at(-1) });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }
}

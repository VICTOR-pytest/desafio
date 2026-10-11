import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';

export interface HealthDependencies {
  em: EntityManager;
  sqs: { client: SQSClient; queueUrl: string } | null;
}

export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

const CHECK_TIMEOUT_MS = 2000;

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_DEPENDENCIES) private readonly dependencies: HealthDependencies,
  ) {}

  @Get()
  legacy() {
    return { status: 'ok' };
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const checks = {
      postgres: await this.checkPostgres(),
      sqs: await this.checkSqs(),
    };
    const healthy = Object.values(checks).every((state) => state !== 'down');

    response.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? 'ready' : 'unavailable', checks };
  }

  private async checkPostgres(): Promise<'up' | 'down'> {
    try {
      await within(this.dependencies.em.execute('select 1', [], 'all'));
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<'up' | 'down' | 'disabled'> {
    if (!this.dependencies.sqs) {
      return 'disabled';
    }

    try {
      await within(
        this.dependencies.sqs.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.dependencies.sqs.queueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}

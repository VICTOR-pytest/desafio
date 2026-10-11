import { Controller, Get, Header, Inject } from '@nestjs/common';
import { OutboxStore } from '../../application/ports';
import { MetricsRegistry } from '../observability/metrics';

export const METRICS_DEPENDENCIES = Symbol('METRICS_DEPENDENCIES');

export interface MetricsDependencies {
  registry: MetricsRegistry;
  outbox: OutboxStore;
}

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS_DEPENDENCIES) private readonly dependencies: MetricsDependencies,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    const lag = await this.dependencies.outbox.oldestPendingAgeSeconds(new Date());

    this.dependencies.registry.setGauge('outbox_lag_seconds', lag);
    return this.dependencies.registry.render();
  }
}

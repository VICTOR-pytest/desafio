import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Telemetry } from '../../application/ports';
import { IntervalWorker } from './interval-worker';
import { SqsWagerConsumer } from '../sqs/sqs-wager-consumer';

export interface ManagedWorkers {
  intervalWorkers: IntervalWorker[];
  consumer: SqsWagerConsumer | null;
}

@Injectable()
export class WorkersLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    private readonly workers: ManagedWorkers,
    private readonly telemetry: Telemetry,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.consumer?.start();
    this.workers.intervalWorkers.forEach((worker) => worker.start());
    this.telemetry.logger.info('workers started', {
      consumer: this.workers.consumer !== null,
      intervalWorkers: this.workers.intervalWorkers.length,
    });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.telemetry.logger.info('stopping workers', { signal });
    await Promise.all([
      this.workers.consumer?.stop(),
      ...this.workers.intervalWorkers.map((worker) => worker.stop()),
    ]);
    this.telemetry.logger.info('workers stopped');
  }
}

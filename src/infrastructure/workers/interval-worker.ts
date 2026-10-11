import { Logger } from '../../application/ports';

export class IntervalWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.task();
      } catch (error) {
        this.logger.error('worker iteration failed', {
          worker: this.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

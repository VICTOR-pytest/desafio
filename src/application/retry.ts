import { RetryableError } from './errors';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 10;

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  onRetry: (error: RetryableError, attempt: number) => void = () => undefined,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }

      onRetry(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, attempt * BASE_DELAY_MS));
    }
  }
}

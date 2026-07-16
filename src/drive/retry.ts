import { DriveError } from './DriveClient';

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onUnauthorized?: () => Promise<boolean>;
};

export async function withDriveRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const sleep = options.sleep ?? defaultSleep;
  let refreshedAfter401 = false;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof DriveError)) {
        throw error;
      }

      if (error.status === 401 && options.onUnauthorized && !refreshedAfter401) {
        refreshedAfter401 = true;
        const refreshed = await options.onUnauthorized();
        if (refreshed) {
          continue;
        }
      }

      if (!isRetryable(error.status) || attempt >= maxRetries) {
        throw error;
      }

      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

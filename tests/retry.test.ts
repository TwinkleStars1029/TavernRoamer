import { describe, expect, it } from 'vitest';
import { DriveError } from '../src/drive/DriveClient';
import { withDriveRetry } from '../src/drive/retry';

describe('withDriveRetry', () => {
  it('retries 429 and 5xx errors', async () => {
    let attempts = 0;
    const result = await withDriveRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new DriveError('busy', 429);
        }
        return 'ok';
      },
      { sleep: async () => undefined }
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('refreshes once on 401', async () => {
    let attempts = 0;
    let refreshes = 0;
    const result = await withDriveRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new DriveError('unauthorized', 401);
        }
        return 'ok';
      },
      {
        sleep: async () => undefined,
        onUnauthorized: async () => {
          refreshes += 1;
          return true;
        }
      }
    );

    expect(result).toBe('ok');
    expect(refreshes).toBe(1);
  });

  it('throws after retry exhaustion', async () => {
    await expect(
      withDriveRetry(
        async () => {
          throw new DriveError('down', 503);
        },
        { maxRetries: 1, sleep: async () => undefined }
      )
    ).rejects.toMatchObject({ status: 503 });
  });
});

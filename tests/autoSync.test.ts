import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSyncController } from '../src/chat/AutoSyncController';

describe('AutoSyncController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for N messages and debounces uploads', () => {
    vi.useFakeTimers();
    const store = {
      tavern_roamer_settings: {
        deviceName: 'A電腦',
        googleClientId: '',
        autoSyncEnabled: true,
        autoSyncEveryN: 2,
        chatRetention: { mode: 'keep_latest_n', latestN: 10 }
      }
    };
    vi.stubGlobal('getVariables', () => store);
    const upload = vi.fn(async () => undefined);
    const controller = new AutoSyncController({ upload, debounceMs: 10_000 });

    controller.handleMessageCompleted();
    vi.advanceTimersByTime(10_000);
    expect(upload).not.toHaveBeenCalled();

    controller.handleMessageCompleted();
    controller.handleMessageCompleted();
    controller.handleMessageCompleted();
    vi.advanceTimersByTime(9_999);
    expect(upload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

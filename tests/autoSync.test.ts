import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSyncController } from '../src/chat/AutoSyncController';
import type { ChatSyncTarget } from '../src/chat/context';

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

    const target = syncTarget('A');
    controller.handleMessageCompleted(target);
    vi.advanceTimersByTime(10_000);
    expect(upload).not.toHaveBeenCalled();

    controller.handleMessageCompleted(target);
    controller.handleMessageCompleted(target);
    controller.handleMessageCompleted(target);
    vi.advanceTimersByTime(9_999);
    expect(upload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps counters and delayed upload targets separate for each chat', () => {
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
    const chatA = syncTarget('A');
    const chatB = syncTarget('B');

    controller.handleMessageCompleted(chatA);
    controller.handleMessageCompleted(chatB);
    controller.handleMessageCompleted(chatA);
    vi.advanceTimersByTime(10_000);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(chatA);

    controller.handleMessageCompleted(chatB);
    vi.advanceTimersByTime(10_000);
    expect(upload).toHaveBeenLastCalledWith(chatB);
  });
});

function syncTarget(id: string): ChatSyncTarget {
  return {
    operationId: `operation-${id}`,
    key: id,
    ref: {
      nativeChatId: id,
      rawFileName: `${id}.jsonl`,
      displayFileName: `${id}.jsonl`,
      avatarUrl: 'avatar.png'
    },
    meta: { chat_id: id, role_key: 'Role' },
    contextRevision: 0
  };
}

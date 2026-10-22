import { describe, expect, it } from 'vitest';
import { ChatOperationCoordinator } from '../src/chat/ChatOperationCoordinator';

describe('ChatOperationCoordinator', () => {
  it('runs operations for the same chat in order', async () => {
    const coordinator = new ChatOperationCoordinator();
    const events: string[] = [];
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = coordinator.run('chat-a', async () => {
      events.push('first:start');
      markFirstStarted();
      await firstGate;
      events.push('first:end');
    });
    const second = coordinator.run('chat-a', async () => {
      events.push('second:start');
    });

    await firstStarted;
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('continues the queue after a failed operation', async () => {
    const coordinator = new ChatOperationCoordinator();
    const first = coordinator.run('chat-a', async () => {
      throw new Error('failed');
    });
    const second = coordinator.run('chat-a', async () => 'completed');

    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe('completed');
  });
});

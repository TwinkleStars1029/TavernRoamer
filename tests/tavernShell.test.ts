import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernServices } from '../src/tavern';

describe('Tavern shell adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes to chat changes, tracks the latest file and disposes the host subscription', () => {
    const stop = vi.fn();
    let listener: ((chatFileName: string | null) => void) | undefined;
    const eventOn = vi.fn((eventName: string, handler: (chatFileName: string | null) => void) => {
      expect(eventName).toBe('host_chat_changed');
      listener = handler;
      return { stop };
    });
    vi.stubGlobal('eventOn', eventOn);
    vi.stubGlobal('tavern_events', { CHAT_CHANGED: 'host_chat_changed' });
    const shell = createTavernServices().shell;
    const handler = vi.fn();

    const off = shell.onChatChanged(handler);
    listener?.('Alice - chat.jsonl');

    expect(handler).toHaveBeenCalledWith('Alice - chat.jsonl');
    expect(shell.getContext().chatFileName).toBe('Alice - chat.jsonl');
    off();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses the generation fallback event and returns a harmless disposer when events are unavailable', () => {
    const eventOn = vi.fn(() => ({ stop: vi.fn() }));
    vi.stubGlobal('eventOn', eventOn);
    const shell = createTavernServices().shell;

    shell.onMessageCompleted(vi.fn());
    expect(eventOn).toHaveBeenCalledWith('generation_ended', expect.any(Function));

    vi.stubGlobal('eventOn', undefined);
    expect(() => createTavernServices().shell.onChatChanged(vi.fn())()).not.toThrow();
  });

  it('subscribes to message mutations so the status can be marked dirty immediately', () => {
    const listeners = new Map<string, () => void>();
    const stops = new Map<string, ReturnType<typeof vi.fn>>();
    vi.stubGlobal('tavern_events', {
      MESSAGE_SENT: 'sent',
      MESSAGE_RECEIVED: 'received',
      MESSAGE_EDITED: 'edited',
      MESSAGE_DELETED: 'deleted',
      MESSAGE_SWIPED: 'swiped'
    });
    vi.stubGlobal('eventOn', (eventName: string, handler: () => void) => {
      listeners.set(eventName, handler);
      const stop = vi.fn();
      stops.set(eventName, stop);
      return { stop };
    });
    const handler = vi.fn();

    const off = createTavernServices().shell.onChatContentChanged(handler);
    for (const listener of listeners.values()) listener();

    expect([...listeners.keys()]).toEqual(['sent', 'received', 'edited', 'deleted', 'swiped']);
    expect(handler).toHaveBeenCalledTimes(5);
    off();
    expect([...stops.values()].every(stop => stop.mock.calls.length === 1)).toBe(true);
  });
});

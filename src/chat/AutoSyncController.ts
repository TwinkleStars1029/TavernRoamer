import { loadSettings } from '../settings';
import type { ChatSyncTarget } from './context';

export type AutoSyncControllerOptions = {
  upload: (target: ChatSyncTarget) => Promise<void>;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  debounceMs?: number;
};

type PendingTarget = {
  target: ChatSyncTarget;
  messageCount: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export class AutoSyncController {
  private pending = new Map<string, PendingTarget>();
  private setTimeoutImpl: typeof setTimeout;
  private clearTimeoutImpl: typeof clearTimeout;
  private debounceMs: number;

  constructor(private options: AutoSyncControllerOptions) {
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.debounceMs = options.debounceMs ?? 10_000;
  }

  handleMessageCompleted(target: ChatSyncTarget): void {
    const settings = loadSettings();
    if (!settings.autoSyncEnabled) {
      return;
    }
    const pending = this.pending.get(target.key) ?? { target, messageCount: 0, timer: null };
    pending.target = target;
    pending.messageCount += 1;
    this.pending.set(target.key, pending);
    if (pending.messageCount < settings.autoSyncEveryN) {
      return;
    }
    pending.messageCount = 0;
    this.schedule(pending);
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) this.clearTimeoutImpl(pending.timer);
    }
    this.pending.clear();
  }

  private schedule(pending: PendingTarget): void {
    if (pending.timer) {
      this.clearTimeoutImpl(pending.timer);
    }
    pending.timer = this.setTimeoutImpl(() => {
      pending.timer = null;
      const target = pending.target;
      if (pending.messageCount === 0) this.pending.delete(target.key);
      if (!loadSettings().autoSyncEnabled) return;
      void this.options.upload(target);
    }, this.debounceMs);
  }
}

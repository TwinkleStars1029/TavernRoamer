import { loadSettings } from '../settings';

export type AutoSyncControllerOptions = {
  upload: () => Promise<void>;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  debounceMs?: number;
};

export class AutoSyncController {
  private messageCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setTimeoutImpl: typeof setTimeout;
  private clearTimeoutImpl: typeof clearTimeout;
  private debounceMs: number;

  constructor(private options: AutoSyncControllerOptions) {
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.debounceMs = options.debounceMs ?? 10_000;
  }

  handleMessageCompleted(): void {
    const settings = loadSettings();
    if (!settings.autoSyncEnabled) {
      return;
    }
    this.messageCount += 1;
    if (this.messageCount < settings.autoSyncEveryN) {
      return;
    }
    this.messageCount = 0;
    this.schedule();
  }

  stop(): void {
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
    }
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.options.upload();
    }, this.debounceMs);
  }
}

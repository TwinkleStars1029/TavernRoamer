import { describe, expect, it } from 'vitest';
import { formatAutoSyncLabel, formatPendingLabel, progressRatioLabel, statusPill } from '../src/ui';
import type { SyncStatus } from '../src/types';

describe('statusPill', () => {
  it.each([
    ['synced', '已是最新', 'green'],
    ['newer_remote', '雲端有新版', 'yellow'],
    ['local_dirty', '本地有未上傳變更', 'orange'],
    ['not_connected', '未連線', 'grey'],
    ['unknown', '未知', 'grey']
  ] as const)('maps %s to a labelled tone', (status, label, tone) => {
    expect(statusPill(status as SyncStatus)).toEqual({ label, tone });
  });
});

describe('formatPendingLabel', () => {
  it('hides the badge when the queue is empty (or after flush)', () => {
    expect(formatPendingLabel(0)).toEqual({ text: '無', visible: false, tone: 'normal' });
  });

  it('shows a warning label when the queue is non-empty', () => {
    expect(formatPendingLabel(3)).toEqual({ text: '待傳 3 筆', visible: true, tone: 'warn' });
  });

  it('treats negative or non-finite counts as empty', () => {
    expect(formatPendingLabel(-1).visible).toBe(false);
    expect(formatPendingLabel(Number.NaN).visible).toBe(false);
  });
});

describe('formatAutoSyncLabel', () => {
  it('describes the interval when enabled', () => {
    expect(formatAutoSyncLabel({ autoSyncEnabled: true, autoSyncEveryN: 5 })).toBe('每 5 則');
  });

  it('reports disabled state', () => {
    expect(formatAutoSyncLabel({ autoSyncEnabled: false, autoSyncEveryN: 5 })).toBe('已停用');
  });
});

describe('progressRatioLabel', () => {
  it('renders settled over total', () => {
    expect(progressRatioLabel(3, 5)).toBe('3/5');
    expect(progressRatioLabel(0, 1)).toBe('0/1');
  });
});

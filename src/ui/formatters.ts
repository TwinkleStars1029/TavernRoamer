import type { Settings, SyncStatus } from '../types';

export type PillTone = 'green' | 'yellow' | 'orange' | 'red' | 'grey';
export type ProgressSummary = {
  label: string;
  tone: 'running' | 'success' | 'warning' | 'error' | 'neutral';
  finished: boolean;
};

export function statusPill(status: SyncStatus): { label: string; tone: PillTone } {
  switch (status) {
    case 'synced': return { label: '已是最新', tone: 'green' };
    case 'remote_available': return { label: '雲端已有版本', tone: 'yellow' };
    case 'newer_remote': return { label: '雲端有新版', tone: 'yellow' };
    case 'local_dirty': return { label: '本地有未上傳變更', tone: 'orange' };
    case 'conflict': return { label: '雙方皆有變更', tone: 'red' };
    case 'remote_missing': return { label: '雲端版本遺失', tone: 'red' };
    case 'remote_mismatch': return { label: '版本狀態異常', tone: 'red' };
    case 'check_failed': return { label: '無法核對雲端', tone: 'grey' };
    case 'untracked': return { label: '尚未同步', tone: 'grey' };
    case 'not_connected': return { label: '未連線', tone: 'grey' };
    default: return { label: '尚未核對', tone: 'grey' };
  }
}

export function formatPendingLabel(count: number): { text: string; visible: boolean; tone: 'warn' | 'normal' } {
  if (!Number.isFinite(count) || count <= 0) return { text: '無', visible: false, tone: 'normal' };
  return { text: `待傳 ${Math.floor(count)} 筆`, visible: true, tone: 'warn' };
}

export function formatAutoSyncLabel(settings: Pick<Settings, 'autoSyncEnabled' | 'autoSyncEveryN'>): string {
  return settings.autoSyncEnabled ? `每 ${settings.autoSyncEveryN} 則` : '已停用';
}

export function progressRatioLabel(settled: number, total: number): string {
  return `${settled}/${total}`;
}

export function uploadCompletionMessage(op: string | null, states: readonly string[]): string | null {
  const isUploadOperation = op === 'upload' || op === 'backup';
  return isUploadOperation && states.length > 0 && states.every(state => state === 'done')
    ? '全部檔案上傳完成'
    : null;
}

export function summarizeProgress(states: readonly string[]): ProgressSummary {
  if (states.length === 0) return { label: '尚未開始', tone: 'neutral', finished: false };
  if (states.some(state => state === 'pending' || state === 'active')) {
    return { label: '正在處理', tone: 'running', finished: false };
  }
  const failed = states.filter(state => state === 'error' || state === 'aborted').length;
  const done = states.filter(state => state === 'done').length;
  const skipped = states.filter(state => state === 'skipped').length;
  const queued = states.filter(state => state === 'queued').length;
  const warnings = states.filter(state => state === 'warning').length;
  if (failed > 0 && done + skipped > 0) return { label: `部分完成，${failed} 項未完成`, tone: 'warning', finished: true };
  if (failed > 0) return { label: `操作失敗，${failed} 項未完成`, tone: 'error', finished: true };
  if (queued > 0) return {
    label: done + skipped > 0 ? `部分完成，${queued} 項等待補傳` : `${queued} 項等待補傳`,
    tone: 'warning',
    finished: true
  };
  if (warnings > 0) return { label: `部分完成，${warnings} 項尚待核對`, tone: 'warning', finished: true };
  if (done > 0) {
    return { label: skipped > 0 ? `操作完成，${skipped} 項略過` : '全部完成', tone: 'success', finished: true };
  }
  return { label: '沒有可處理的項目', tone: 'neutral', finished: true };
}

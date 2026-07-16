import type { TavernChatAdapter } from '../chat/ChatSyncService';
import { ensureSyncMeta } from '../chat/meta';
import { buildVersionFilename, createUtcTimestamp } from '../drive/version';
import type { DriveService } from '../drive/DriveService';
import { loadSettings } from '../settings';
import type { ChatSyncMeta } from '../types';
import {
  ENVIRONMENT_ITEM_KINDS,
  type EnvironmentItemKind,
  type EnvironmentProgressEvent,
  type EnvironmentSnapshot,
} from './types';

export type EnvironmentRestoreItemResult = {
  kind: EnvironmentItemKind;
  status: 'done' | 'error' | 'aborted' | 'skipped';
  filename?: string;
  error?: string;
};

export type EnvironmentRestoreResult = {
  items: EnvironmentRestoreItemResult[];
  restorePointPath: string[];
};

export type EnvironmentRestoreOptions = {
  meta?: ChatSyncMeta;
  onProgress?: (event: EnvironmentProgressEvent) => void;
};

export class EnvironmentRestoreService {
  constructor(
    private tavern: TavernChatAdapter,
    private drive: DriveService
  ) {}

  ensureSyncMeta(): ChatSyncMeta {
    return ensureSyncMeta(this.tavern, loadSettings().deviceName);
  }

  async restoreLatest(
    kinds: readonly EnvironmentItemKind[],
    options: EnvironmentRestoreOptions = {}
  ): Promise<EnvironmentRestoreResult> {
    const { meta = this.ensureSyncMeta(), onProgress } = options;
    const orderedKinds = ENVIRONMENT_ITEM_KINDS.filter(kind => kinds.includes(kind));
    const resolved = await Promise.all(
      orderedKinds.map(async kind => {
        const versions = await this.drive.listVersions(environmentItemPath(meta, kind));
        const latest = versions.at(-1) ?? null;
        return { kind, latest };
      })
    );

    if (!resolved.some(entry => entry.latest !== null)) {
      throw new Error('雲端找不到可還原的環境備份');
    }

    // 同一批覆蓋前備份共用一個時間戳（資料夾層與檔名層皆一致）
    const restorePointTimestamp = createUtcTimestamp();
    const restorePointPath = ['SillyTavernSync', meta.role_key, meta.chat_id, '_pre_restore', restorePointTimestamp];
    const restorePointFilename = buildVersionFilename(loadSettings().deviceName);

    const items: EnvironmentRestoreItemResult[] = [];
    for (const entry of resolved) {
      // 雲端沒版本 → 略過，不備份也不套用
      if (entry.latest === null) {
        items.push({ kind: entry.kind, status: 'skipped' });
        continue;
      }

      // 覆蓋前備份：只備份即將被覆蓋的項目；失敗則中止該項、不 download 不 apply
      try {
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'start' });
        const folderId = await this.drive.ensureFolderPath([...restorePointPath, entry.kind]);
        const currentSnapshot = await this.exportSnapshot(entry.kind);
        await this.drive.uploadJson(folderId, restorePointFilename, currentSnapshot);
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'done', filename: restorePointFilename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'error', error: message });
        items.push({ kind: entry.kind, status: 'aborted', error: message });
        continue;
      }

      // download → apply：任一步失敗標記 error，其他項繼續
      let step: EnvironmentProgressEvent['step'] = 'download';
      try {
        onProgress?.({ kind: entry.kind, step: 'download', state: 'start' });
        const snapshot = await this.downloadSnapshot(entry.kind, entry.latest.fileId);
        onProgress?.({ kind: entry.kind, step: 'download', state: 'done', filename: entry.latest.filename });

        step = 'apply';
        onProgress?.({ kind: entry.kind, step: 'apply', state: 'start' });
        await this.applySnapshot(snapshot);
        onProgress?.({ kind: entry.kind, step: 'apply', state: 'done' });

        items.push({ kind: entry.kind, status: 'done', filename: entry.latest.filename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onProgress?.({ kind: entry.kind, step, state: 'error', error: message });
        items.push({ kind: entry.kind, status: 'error', error: message });
      }
    }

    return { items, restorePointPath };
  }

  private async exportSnapshot(kind: EnvironmentItemKind): Promise<EnvironmentSnapshot> {
    if (kind === 'character') {
      return this.tavern.exportCharacter();
    }
    if (kind === 'world') {
      return this.tavern.exportWorld();
    }
    if (kind === 'persona') {
      return this.tavern.exportPersona();
    }
    if (kind === 'preset') {
      return this.tavern.exportPreset();
    }
    return this.tavern.exportRegex();
  }

  private async downloadSnapshot(kind: EnvironmentItemKind, fileId: string): Promise<EnvironmentSnapshot> {
    const downloaded = await this.drive.downloadJson(fileId);
    if (!downloaded || typeof downloaded !== 'object') {
      throw new Error(`環境備份 ${kind} 內容格式錯誤`);
    }
    const snapshot = downloaded as EnvironmentSnapshot;
    if (snapshot.kind !== kind || typeof snapshot.exportedAt !== 'string') {
      throw new Error(`環境備份 ${kind} 內容格式錯誤`);
    }
    return snapshot;
  }

  private async applySnapshot(snapshot: EnvironmentSnapshot): Promise<void> {
    if (snapshot.kind === 'character') {
      await this.tavern.applyCharacter(snapshot);
      return;
    }
    if (snapshot.kind === 'world') {
      await this.tavern.applyWorld(snapshot);
      return;
    }
    if (snapshot.kind === 'persona') {
      await this.tavern.applyPersona(snapshot);
      return;
    }
    if (snapshot.kind === 'preset') {
      await this.tavern.applyPreset(snapshot);
      return;
    }
    await this.tavern.applyRegex(snapshot);
  }
}

function environmentItemPath(meta: Pick<ChatSyncMeta, 'role_key' | 'chat_id'>, kind: EnvironmentItemKind): string[] {
  return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

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
import type { EnvironmentApplyPort, EnvironmentContextPort, EnvironmentExportPort } from './EnvironmentPort';
import { parseEnvironmentSnapshot } from './validation';

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
    private tavern: EnvironmentExportPort & EnvironmentApplyPort & EnvironmentContextPort,
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
    const contextKey = this.tavern.captureEnvironmentContext?.();
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

      let snapshot: EnvironmentSnapshot;
      let preparationStep: EnvironmentProgressEvent['step'] = 'download';
      try {
        onProgress?.({ kind: entry.kind, step: 'download', state: 'start' });
        const downloaded = await this.drive.downloadJson(entry.latest.fileId);
        onProgress?.({ kind: entry.kind, step: 'download', state: 'done', filename: entry.latest.filename });
        preparationStep = 'validate';
        onProgress?.({ kind: entry.kind, step: 'validate', state: 'start' });
        snapshot = parseEnvironmentSnapshot(entry.kind, downloaded);
        onProgress?.({ kind: entry.kind, step: 'validate', state: 'done', filename: entry.latest.filename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onProgress?.({ kind: entry.kind, step: preparationStep, state: 'error', error: message });
        items.push({ kind: entry.kind, status: 'error', error: message });
        continue;
      }

      // 覆蓋前備份：遠端資料先通過驗證；目前資料也必須有效才能建立還原點。
      try {
        this.assertContext(contextKey);
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'start' });
        const folderId = await this.drive.ensureFolderPath([...restorePointPath, entry.kind]);
        const currentSnapshot = parseEnvironmentSnapshot(entry.kind, await this.exportSnapshot(entry.kind));
        this.assertContext(contextKey);
        await this.drive.uploadJson(folderId, restorePointFilename, currentSnapshot);
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'done', filename: restorePointFilename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'error', error: message });
        items.push({ kind: entry.kind, status: 'aborted', error: message });
        continue;
      }

      // apply 失敗標記 error，其他無相依項目繼續。
      const step: EnvironmentProgressEvent['step'] = 'apply';
      try {
        this.assertContext(contextKey);
        onProgress?.({ kind: entry.kind, step: 'apply', state: 'start' });
        await this.applySnapshot(snapshot, contextKey);
        this.assertContext(contextKey);
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

  private async applySnapshot(snapshot: EnvironmentSnapshot, contextKey?: string): Promise<void> {
    if (snapshot.kind === 'character') {
      await this.tavern.applyCharacter(snapshot, contextKey);
      return;
    }
    if (snapshot.kind === 'world') {
      await this.tavern.applyWorld(snapshot, contextKey);
      return;
    }
    if (snapshot.kind === 'persona') {
      await this.tavern.applyPersona(snapshot, contextKey);
      return;
    }
    if (snapshot.kind === 'preset') {
      await this.tavern.applyPreset(snapshot, contextKey);
      return;
    }
    await this.tavern.applyRegex(snapshot, contextKey);
  }

  private assertContext(contextKey: string | undefined): void {
    if (contextKey && this.tavern.isEnvironmentContextCurrent && !this.tavern.isEnvironmentContextCurrent(contextKey)) {
      throw new Error('操作期間角色或聊天已切換，環境還原已中止');
    }
  }
}

function environmentItemPath(meta: Pick<ChatSyncMeta, 'role_key' | 'chat_id'>, kind: EnvironmentItemKind): string[] {
  return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

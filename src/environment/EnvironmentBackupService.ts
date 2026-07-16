import type { TavernChatAdapter } from '../chat/ChatSyncService';
import { ensureSyncMeta } from '../chat/meta';
import { buildVersionFilename } from '../drive/version';
import type { DriveService } from '../drive/DriveService';
import { loadSettings } from '../settings';
import type { ChatSyncMeta } from '../types';
import {
  ENVIRONMENT_ITEM_KINDS,
  type EnvironmentItemKind,
  type EnvironmentProgressEvent,
  type EnvironmentSnapshot,
} from './types';

export type EnvironmentBackupResult = {
  kind: EnvironmentItemKind;
  status: 'done' | 'error';
  filename?: string;
  error?: string;
};

export type EnvironmentBackupOptions = {
  meta?: ChatSyncMeta;
  onProgress?: (event: EnvironmentProgressEvent) => void;
};

export type EnvironmentSnapshotFor<K extends EnvironmentItemKind> = Extract<EnvironmentSnapshot, { kind: K }>;

export class EnvironmentBackupService {
  constructor(
    private tavern: TavernChatAdapter,
    private drive: DriveService
  ) {}

  async backupAll(options: EnvironmentBackupOptions = {}): Promise<EnvironmentBackupResult[]> {
    return this.backupItems(ENVIRONMENT_ITEM_KINDS, options);
  }

  async backupItems(
    kinds: readonly EnvironmentItemKind[],
    options: EnvironmentBackupOptions = {}
  ): Promise<EnvironmentBackupResult[]> {
    const { meta = this.ensureSyncMeta(), onProgress } = options;
    // 同一批備份共用一個 UTC 時間戳（手冊第九章：時間戳同一批一致）
    const filename = buildVersionFilename(loadSettings().deviceName);
    const results: EnvironmentBackupResult[] = [];
    for (const kind of kinds) {
      let step: EnvironmentProgressEvent['step'] = 'export';
      try {
        onProgress?.({ kind, step: 'export', state: 'start' });
        const snapshot = await this.exportSnapshot(kind);
        onProgress?.({ kind, step: 'export', state: 'done' });

        step = 'upload';
        onProgress?.({ kind, step: 'upload', state: 'start' });
        const folderId = await this.drive.ensureFolderPath(environmentItemPath(meta, kind));
        await this.drive.uploadJson(folderId, filename, snapshot);
        await this.cleanupOldVersions(folderId);
        onProgress?.({ kind, step: 'upload', state: 'done', filename });

        results.push({ kind, status: 'done', filename });
      } catch (error) {
        // 單項失敗：記錄後繼續下一項（取代原本 throw 全斷）
        const message = error instanceof Error ? error.message : String(error);
        onProgress?.({ kind, step, state: 'error', error: message });
        results.push({ kind, status: 'error', error: message });
      }
    }
    return results;
  }

  async listItemVersions(kind: EnvironmentItemKind, meta = this.ensureSyncMeta()) {
    return this.drive.listVersions(environmentItemPath(meta, kind));
  }

  async downloadItem<K extends EnvironmentItemKind>(kind: K, fileId: string): Promise<EnvironmentSnapshotFor<K>> {
    const downloaded = await this.drive.downloadJson(fileId);
    return assertSnapshotKind(kind, downloaded);
  }

  ensureSyncMeta(): ChatSyncMeta {
    return ensureSyncMeta(this.tavern, loadSettings().deviceName);
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

  private async cleanupOldVersions(folderId: string): Promise<void> {
    const settings = loadSettings();
    if (settings.chatRetention.mode !== 'keep_latest_n') {
      return;
    }
    const versions = await this.drive.listVersions(folderId);
    const stale = versions.slice(0, Math.max(0, versions.length - settings.chatRetention.latestN));
    await Promise.all(stale.map(version => this.drive.deleteFile(version.fileId)));
  }
}

export function environmentItemPath(meta: Pick<ChatSyncMeta, 'role_key' | 'chat_id'>, kind: EnvironmentItemKind): string[] {
  return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

function assertSnapshotKind<K extends EnvironmentItemKind>(kind: K, value: unknown): EnvironmentSnapshotFor<K> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Environment snapshot for ${kind} is not a JSON object`);
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.kind !== kind || typeof snapshot.exportedAt !== 'string') {
    throw new Error(`Environment snapshot for ${kind} is invalid`);
  }
  return snapshot as EnvironmentSnapshotFor<K>;
}

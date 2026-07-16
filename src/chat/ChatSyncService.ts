import { buildVersionFilename } from '../drive/version';
import type { DriveService } from '../drive/DriveService';
import type {
  CharacterSnapshot,
  PersonaSnapshot,
  PresetSnapshot,
  RegexSnapshot,
  WorldSnapshot
} from '../environment/types';
import { loadSettings } from '../settings';
import type { ChatSyncMeta } from '../types';
import { ensureSyncMeta, updateLastSyncedVersion, type ChatMetaStore } from './meta';
import { createChatPackage, unpackChatPackage, type ChatPackage, type ChatMessagePackage } from './package';
import { enqueueUpload, incrementQueuedUpload, loadUploadQueue, removeQueuedUpload } from './queue';

const RAW_CHAT_MIME = 'application/x-ndjson; charset=UTF-8';

export type RawChatFile = {
  content: string;
  messageCount: number;
};

export type TavernChatAdapter = ChatMetaStore & {
  getMessages: () => ChatMessagePackage[];
  getChatWorldbook: () => string | null;
  exportRawChat: () => Promise<RawChatFile>;
  exportCharacter: () => Promise<CharacterSnapshot>;
  exportWorld: () => Promise<WorldSnapshot>;
  exportPersona: () => Promise<PersonaSnapshot>;
  exportPreset: () => Promise<PresetSnapshot>;
  exportRegex: () => Promise<RegexSnapshot>;
  applyCharacter: (snapshot: CharacterSnapshot) => Promise<void>;
  applyWorld: (snapshot: WorldSnapshot) => Promise<void>;
  applyPersona: (snapshot: PersonaSnapshot) => Promise<void>;
  applyPreset: (snapshot: PresetSnapshot) => Promise<void>;
  applyRegex: (snapshot: RegexSnapshot) => Promise<void>;
  replaceRawChat: (content: string) => Promise<void>;
  replaceChat: (chatPackage: ChatPackage) => Promise<void>;
};

export type UploadResult = {
  meta: ChatSyncMeta;
  filename: string;
  queued: boolean;
};

export class ChatSyncService {
  constructor(
    private tavern: TavernChatAdapter,
    private drive: DriveService
  ) {}

  ensureSyncMeta(): ChatSyncMeta {
    return ensureSyncMeta(this.tavern, loadSettings().deviceName);
  }

  packChat(meta = this.ensureSyncMeta()): ChatPackage {
    const settings = loadSettings();
    return createChatPackage({
      meta,
      deviceName: settings.deviceName,
      messages: this.tavern.getMessages(),
      chatVariables: this.tavern.getChatVariables(),
      chatWorldbook: this.tavern.getChatWorldbook()
    });
  }

  async uploadCurrentChat(options: { queueOnFail?: boolean } = {}): Promise<UploadResult> {
    const meta = this.ensureSyncMeta();
    const rawChat = await this.tavern.exportRawChat();
    const filename = buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl');
    const path = driveChatPath(meta);
    try {
      const folderId = await this.drive.ensureFolderPath(path);
      await this.drive.uploadText(folderId, filename, rawChat.content, RAW_CHAT_MIME);
      await this.cleanupOldVersions(folderId);
      updateLastSyncedVersion(this.tavern, meta, filename, rawChat.messageCount);
      return { meta: { ...meta, last_synced_version: filename }, filename, queued: false };
    } catch (error) {
      if (options.queueOnFail) {
        enqueueUpload({ path, filename, package: rawChat.content, mimeType: RAW_CHAT_MIME });
        return { meta, filename, queued: true };
      }
      throw error;
    }
  }

  async flushQueue(): Promise<{ uploaded: number; remaining: number }> {
    let uploaded = 0;
    for (const item of loadUploadQueue()) {
      try {
        const folderId = await this.drive.ensureFolderPath(item.path);
        if (typeof item.package === 'string') {
          await this.drive.uploadText(folderId, item.filename, item.package, item.mimeType);
        } else {
          await this.drive.uploadJson(folderId, item.filename, item.package);
        }
        removeQueuedUpload(item.id);
        uploaded += 1;
      } catch {
        incrementQueuedUpload(item.id);
      }
    }
    return { uploaded, remaining: loadUploadQueue().length };
  }

  async downloadLatestAndReplace(): Promise<string> {
    const meta = this.ensureSyncMeta();
    const path = driveChatPath(meta);
    const versions = await this.drive.listVersions(path);
    const latest = versions.at(-1);
    if (!latest) {
      throw new Error('雲端沒有可下載的聊天版本');
    }
    await this.uploadPreRestore(meta);
    if (latest.filename.endsWith('.jsonl')) {
      const content = await this.drive.downloadText(latest.fileId);
      await this.tavern.replaceRawChat(content);
      updateLastSyncedVersion(this.tavern, meta, latest.filename, countJsonlMessages(content));
      return latest.filename;
    }
    const downloaded = await this.drive.downloadJson(latest.fileId);
    const chatPackage = unpackChatPackage(downloaded);
    await this.tavern.replaceChat(chatPackage);
    updateLastSyncedVersion(this.tavern, meta, latest.filename, chatPackage.messages.length);
    return latest.filename;
  }

  async getLatestRemoteFilename(meta = this.ensureSyncMeta()): Promise<string | null> {
    const versions = await this.drive.listVersions(driveChatPath(meta));
    return versions.at(-1)?.filename ?? null;
  }

  private async uploadPreRestore(meta: ChatSyncMeta): Promise<void> {
    const rawChat = await this.tavern.exportRawChat();
    const folderId = await this.drive.ensureFolderPath([
      'SillyTavernSync',
      meta.role_key,
      meta.chat_id,
      '_pre_restore',
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
    ]);
    await this.drive.uploadText(
      folderId,
      buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl'),
      rawChat.content,
      RAW_CHAT_MIME
    );
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

export function driveChatPath(meta: Pick<ChatSyncMeta, 'role_key' | 'chat_id'>): string[] {
  return ['SillyTavernSync', meta.role_key, meta.chat_id, 'chat'];
}

function countJsonlMessages(content: string): number {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) {
    return 0;
  }
  try {
    const header = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    if (header.user_name !== undefined || header.name !== undefined || header.chat_metadata !== undefined) {
      return Math.max(0, lines.length - 1);
    }
  } catch {
    return lines.length;
  }
  return lines.length;
}

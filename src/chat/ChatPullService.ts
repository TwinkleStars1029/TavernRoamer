import type { CharacterSnapshot } from '../environment/types';
import type { ChatSyncMeta } from '../types';
import { sanitizeRoleKey } from '../roleKey';
import type { DriveService } from '../drive/DriveService';
import { loadSettings } from '../settings';
import { countJsonlMessages } from './ChatSyncService';
import { buildPulledChatFileName, deriveChatId } from './meta';

export type TavernPullAdapter = {
  listCharacterNames: () => string[];
  selectCharacterByName: (name: string) => Promise<void>;
  getCurrentCharacterName: () => string | null;
  listCurrentCharacterChatFiles: () => Promise<string[]>;
  createAndOpenChatFile: (fileName: string, rawJsonl: string) => Promise<void>;
  applyCharacter: (snapshot: CharacterSnapshot) => Promise<void>;
  writeChatMeta: (meta: ChatSyncMeta) => void;
};

const ROOT_FOLDER = 'SillyTavernSync';

export type PullResult = {
  filename: string;
  chatFileName: string;
  characterRestored: boolean;
};

export function chatFileMatchesChatId(fileName: string, chatId: string): boolean {
  if (deriveChatId(fileName) === chatId) {
    return true;
  }
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem === chatId || stem.endsWith(` - ${chatId}`);
}

export class ChatPullService {
  constructor(
    private tavern: TavernPullAdapter,
    private drive: DriveService
  ) {}

  async pullChat(roleKey: string, chatId: string): Promise<PullResult> {
    const characterRestored = await this.ensureCharacter(roleKey, chatId);

    const localChatFiles = await this.tavern.listCurrentCharacterChatFiles();
    if (localChatFiles.some(fileName => chatFileMatchesChatId(fileName, chatId))) {
      throw new Error('本地已存在這個聊天（chat_id 相同）。請切到該聊天後改用「下載並覆蓋」。');
    }

    const versions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'chat']);
    const latest = [...versions].reverse().find(version => version.filename.endsWith('.jsonl'));
    if (!latest) {
      throw new Error('這個聊天在雲端沒有可拉取的原始（.jsonl）版本');
    }
    const content = await this.drive.downloadText(latest.fileId);

    const characterName = this.tavern.getCurrentCharacterName() ?? roleKey;
    const chatFileName = buildPulledChatFileName(characterName, chatId);
    await this.tavern.createAndOpenChatFile(chatFileName, content);

    // 校正 meta：身分沿用雲端，last_synced_version 設為剛拉取的版本
    this.tavern.writeChatMeta({
      chat_id: chatId,
      role_key: roleKey,
      device_name: loadSettings().deviceName,
      last_synced_version: latest.filename,
      last_synced_message_count: countJsonlMessages(content)
    });

    return { filename: latest.filename, chatFileName, characterRestored };
  }

  private async ensureCharacter(roleKey: string, chatId: string): Promise<boolean> {
    const matched = this.findLocalCharacterName(roleKey);
    if (matched) {
      await this.tavern.selectCharacterByName(matched);
      return false;
    }

    const versions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'character']);
    const latest = versions.at(-1);
    if (!latest) {
      throw new Error(
        `本地沒有角色卡「${roleKey}」，且雲端沒有這個聊天的角色卡備份。請先手動安裝角色卡，或在來源裝置執行「備份完整環境」。`
      );
    }
    const snapshot = await this.drive.downloadJson<CharacterSnapshot>(latest.fileId);
    await this.tavern.applyCharacter(snapshot);
    const restored = this.findLocalCharacterName(roleKey) ?? snapshot.characterName;
    if (!restored) {
      throw new Error('角色卡還原後仍找不到對應角色，請重新整理頁面後再試');
    }
    await this.tavern.selectCharacterByName(restored);
    return true;
  }

  private findLocalCharacterName(roleKey: string): string | null {
    return (
      this.tavern.listCharacterNames().find(name => name === roleKey || sanitizeRoleKey(name) === roleKey) ?? null
    );
  }
}

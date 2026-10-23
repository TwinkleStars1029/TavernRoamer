import { sanitizeRoleKey } from '../roleKey';
import type { DriveService } from '../drive/DriveService';
import { loadSettings } from '../settings';
import { buildPulledChatFileName, deriveChatId } from './meta';
import type { ChatPullPort } from './ports/ChatPullPort';
import type { LocalCharacterRef } from './ports/ChatPullPort';
import { parseEnvironmentSnapshot } from '../environment/validation';
import type { CharacterSnapshot } from '../environment/types';
import { createChatContentSnapshot } from './snapshot';
import { getContextRevision } from '../contextRevision';

/** @deprecated Import ChatPullPort from chat/ports/ChatPullPort. */
export type TavernPullAdapter = ChatPullPort;
export type { ChatPullPort } from './ports/ChatPullPort';

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
    private tavern: ChatPullPort,
    private drive: DriveService
  ) {}

  async pullChat(roleKey: string, chatId: string): Promise<PullResult> {
    const operationContext = this.captureContext();
    const chatVersions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'chat']);
    const latest = [...chatVersions].reverse().find(version => version.filename.endsWith('.jsonl'));
    if (!latest) {
      throw new Error('這個聊天在雲端沒有可用來建立聊天的原始（.jsonl）版本');
    }
    const content = await this.drive.downloadText(latest.fileId);
    await createChatContentSnapshot(content);

    let character = this.findLocalCharacter(roleKey);
    let characterRestored = false;
    let pendingCharacter: CharacterSnapshot | null = null;
    if (!character) {
      const versions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'character']);
      const characterVersion = versions.at(-1);
      if (!characterVersion) {
        throw new Error(
          `本地沒有角色卡「${roleKey}」，且雲端沒有這個聊天的角色卡備份。請先手動安裝角色卡，或在來源裝置執行「備份完整環境」。`
        );
      }
      pendingCharacter = parseEnvironmentSnapshot('character', await this.drive.downloadJson(characterVersion.fileId));
    }

    this.assertContextUnchanged(operationContext);
    if (pendingCharacter) {
      await this.tavern.applyCharacter(pendingCharacter);
      character = this.findLocalCharacter(roleKey, pendingCharacter.characterName ?? undefined);
      if (!character) throw new Error('角色卡還原後仍找不到唯一對應角色，請重新整理頁面後再試');
      characterRestored = true;
    }
    if (!character) throw new Error(`本地找不到角色卡：${roleKey}`);
    this.assertContextUnchanged(operationContext);
    await this.tavern.selectCharacter(character);
    this.assertCurrentCharacter(character);
    const selectedContextRevision = getContextRevision();

    const localChatFiles = await this.tavern.listCharacterChatFiles(character);
    this.assertContextRevision(selectedContextRevision, '查詢本地聊天期間畫面已切換，未建立雲端聊天');
    if (localChatFiles.some(fileName => chatFileMatchesChatId(fileName, chatId))) {
      throw new Error('本地已存在這個聊天（chat_id 相同）。請切到該聊天後改用「更新目前聊天」。');
    }

    const chatFileName = buildPulledChatFileName(character.name, chatId);
    this.assertCurrentCharacter(character);
    const filesBeforeSave = await this.tavern.listCharacterChatFiles(character);
    this.assertCurrentCharacter(character);
    this.assertContextRevision(selectedContextRevision, '建立聊天前畫面已切換，未建立雲端聊天');
    if (filesBeforeSave.some(fileName => chatFileMatchesChatId(fileName, chatId))) {
      throw new Error('建立前發現本地已存在這個聊天，未覆蓋既有檔案');
    }
    const chatBeforeSave = this.tavern.getCurrentChatFileName?.() ?? null;
    await this.tavern.createChatFile(character, chatFileName, content);
    this.assertCurrentCharacter(character);
    this.assertContextRevision(selectedContextRevision, '雲端聊天已建立，但操作期間畫面已切換；未自動開啟或寫入同步資訊');
    const chatAfterSave = this.tavern.getCurrentChatFileName?.() ?? null;
    if (chatAfterSave !== chatBeforeSave) {
      throw new Error('雲端聊天已建立，但操作期間目前聊天已切換；未自動開啟或寫入同步資訊');
    }
    await this.tavern.openChatFile(character, chatFileName);
    this.assertCurrentCharacter(character);

    const openedFileName = this.tavern.getCurrentChatFileName?.();
    if (!openedFileName || !chatFileMatchesChatId(openedFileName, chatId)) {
      throw new Error('聊天已切換，未寫入雲端聊天的同步資訊');
    }
    const localSnapshot = await createChatContentSnapshot((await this.tavern.exportRawChat()).content);
    const verifiedFileName = this.tavern.getCurrentChatFileName?.();
    if (!verifiedFileName || !chatFileMatchesChatId(verifiedFileName, chatId)) {
      throw new Error('核對聊天內容期間聊天已切換，未寫入雲端聊天的同步資訊');
    }

    // 身分與版本沿用雲端；內容基準使用酒館實際存回並重新匯出的結果，
    // 避免宿主正規化 JSONL 後立刻被誤判為本地修改。
    this.tavern.writeChatMeta({
      chat_id: chatId,
      role_key: roleKey,
      device_name: loadSettings().deviceName,
      last_synced_version: latest.filename,
      last_synced_message_count: localSnapshot.messageCount,
      last_synced_content_hash: localSnapshot.contentHash,
      last_synced_hash_version: localSnapshot.hashVersion
    });

    return { filename: latest.filename, chatFileName, characterRestored };
  }

  private captureContext(): { character: LocalCharacterRef | null; chatFileName: string | null; contextRevision: number } {
    return {
      character: this.tavern.getCurrentCharacterRef(),
      chatFileName: this.tavern.getCurrentChatFileName?.() ?? null,
      contextRevision: getContextRevision()
    };
  }

  private assertContextUnchanged(expected: {
    character: LocalCharacterRef | null;
    chatFileName: string | null;
    contextRevision: number;
  }): void {
    const current = this.captureContext();
    if (
      current.contextRevision !== expected.contextRevision ||
      current.character?.avatarUrl !== expected.character?.avatarUrl ||
      current.chatFileName !== expected.chatFileName
    ) {
      throw new Error('操作期間角色或聊天已切換，未建立雲端聊天');
    }
  }

  private assertContextRevision(expected: number, message: string): void {
    if (getContextRevision() !== expected) throw new Error(message);
  }

  private assertCurrentCharacter(expected: LocalCharacterRef): void {
    if (this.tavern.getCurrentCharacterRef()?.avatarUrl !== expected.avatarUrl) {
      throw new Error('角色已切換，未繼續建立雲端聊天');
    }
  }

  private findLocalCharacter(roleKey: string, preferredName?: string): LocalCharacterRef | null {
    const matches = this.tavern.listCharacters().filter(character =>
      character.name === preferredName || character.name === roleKey || sanitizeRoleKey(character.name) === roleKey
    );
    if (matches.length > 1) throw new Error(`本地有多張角色卡符合「${roleKey}」，無法安全判定目標`);
    return matches[0] ?? null;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPullService, chatFileMatchesChatId, type TavernPullAdapter } from '../src/chat/ChatPullService';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import type { ChatSyncMeta } from '../src/types';
import type { CharacterSnapshot } from '../src/environment/types';
import { markContextChanged } from '../src/contextRevision';
import { createChatContentSnapshot } from '../src/chat/snapshot';

const CHAT_ID = '2026-06-28@15h24m22s470ms';
const RAW_JSONL = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hello' })}`;

describe('chatFileMatchesChatId', () => {
  it('matches timestamp-derived and fallback chat ids', () => {
    expect(chatFileMatchesChatId(`Alice - ${CHAT_ID}.jsonl`, CHAT_ID)).toBe(true);
    expect(chatFileMatchesChatId(`${CHAT_ID}.jsonl`, CHAT_ID)).toBe(true);
    expect(chatFileMatchesChatId('Alice - chat_123.jsonl', 'chat_123')).toBe(true);
    expect(chatFileMatchesChatId('Alice - 2026-01-01@00h00m00s000ms.jsonl', CHAT_ID)).toBe(false);
  });
});

describe('ChatPullService.pullChat', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pulls latest jsonl, creates file named by chat_id, writes corrected meta', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({ characterNames: ['Alice'] });
    const service = new ChatPullService(adapter, new DriveService(drive));

    const result = await service.pullChat('Alice', CHAT_ID);

    expect(result.characterRestored).toBe(false);
    expect(result.filename).toBe('2026-06-26T09-00-00Z__B電腦.jsonl');
    expect(result.chatFileName).toBe(`Alice - ${CHAT_ID}`);
    expect(adapter.calls.selected).toEqual(['Alice']);
    expect(adapter.calls.created).toEqual([{ fileName: `Alice - ${CHAT_ID}`, content: RAW_JSONL }]);
    const meta = adapter.calls.meta.at(-1);
    expect(meta).toMatchObject({
      chat_id: CHAT_ID,
      role_key: 'Alice',
      device_name: 'DeviceA',
      last_synced_version: '2026-06-26T09-00-00Z__B電腦.jsonl',
      last_synced_message_count: 1
    });
  });

  it('uses the host-normalized local content as the clean baseline after pulling', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const normalized = `${JSON.stringify({ user_name: 'User', chat_metadata: {}, normalized: true })}\n${JSON.stringify({ mes: 'hello', extra: 'host value' })}`;
    const adapter = fakePullAdapter({ characterNames: ['Alice'], exportedRawChat: normalized });

    await new ChatPullService(adapter, new DriveService(drive)).pullChat('Alice', CHAT_ID);

    const snapshot = await createChatContentSnapshot(normalized);
    expect(adapter.calls.meta.at(-1)).toMatchObject({
      last_synced_message_count: snapshot.messageCount,
      last_synced_content_hash: snapshot.contentHash,
      last_synced_hash_version: snapshot.hashVersion
    });
  });

  it('rejects when a local chat with the same chat_id already exists', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({
      characterNames: ['Alice'],
      chatFiles: [`Alice - ${CHAT_ID}.jsonl`]
    });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('更新目前聊天');
    expect(adapter.calls.created).toHaveLength(0);
  });

  it('rejects ambiguous local characters instead of selecting the first matching name', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({ characterNames: ['Alice', 'Alice'] });

    await expect(new ChatPullService(adapter, new DriveService(drive)).pullChat('Alice', CHAT_ID)).rejects.toThrow('多張角色卡');
    expect(adapter.calls.selected).toHaveLength(0);
    expect(adapter.calls.created).toHaveLength(0);
  });

  it('restores character from cloud backup when missing locally', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const { chatFolderId } = await seedCloudChat(drive, 'Alice', CHAT_ID);
    const characterDir = drive.forceCreateFolder('character', chatFolderId);
    const snapshot: CharacterSnapshot = {
      kind: 'character',
      exportedAt: '2026-06-25T00:00:00Z',
      characterName: 'Alice',
      data: { ok: true }
    };
    await drive.uploadJson(characterDir.id, '2026-06-25T14-45-00Z__A電腦.json', snapshot);

    const adapter = fakePullAdapter({ characterNames: [] });
    adapter.onApplyCharacter = applied => {
      adapter.characterNames.push(applied.characterName ?? '');
    };
    const service = new ChatPullService(adapter, new DriveService(drive));

    const result = await service.pullChat('Alice', CHAT_ID);
    expect(result.characterRestored).toBe(true);
    expect(adapter.calls.applied).toHaveLength(1);
    expect(adapter.calls.created).toHaveLength(1);
  });

  it('rejects when character is missing locally and cloud has no character backup', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({ characterNames: [] });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('角色卡');
    expect(adapter.calls.created).toHaveLength(0);
  });

  it('rejects when the cloud chat has no jsonl version', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const root = drive.forceCreateFolder('SillyTavernSync', null);
    const role = drive.forceCreateFolder('Alice', root.id);
    const chat = drive.forceCreateFolder(CHAT_ID, role.id);
    const chatDir = drive.forceCreateFolder('chat', chat.id);
    await drive.uploadJson(chatDir.id, '2026-06-25T14-45-00Z__A電腦.json', { format_version: 1 });

    const adapter = fakePullAdapter({ characterNames: ['Alice'] });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('.jsonl');
  });

  it('does not write metadata when another chat becomes current after creation', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({ characterNames: ['Alice'], switchAfterCreate: 'Alice - another-chat' });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('聊天已切換');
    expect(adapter.calls.meta).toHaveLength(0);
  });

  it('does not open the created chat when the user switches chats while it is being saved', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({ characterNames: ['Alice'], switchDuringSave: 'Alice - user-selected-chat' });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('已建立');
    expect(adapter.calls.created).toHaveLength(1);
    expect(adapter.calls.opened).toHaveLength(0);
    expect(adapter.calls.meta).toHaveLength(0);
  });

  it('rejects an invalid cloud character snapshot before creating or selecting anything', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const { chatFolderId } = await seedCloudChat(drive, 'Alice', CHAT_ID);
    const characterDir = drive.forceCreateFolder('character', chatFolderId);
    await drive.uploadJson(characterDir.id, '2026-06-25T14-45-00Z__A電腦.json', {
      schemaVersion: 1,
      kind: 'character',
      exportedAt: '2026-06-25T00:00:00Z',
      characterName: 'Alice'
    });
    const adapter = fakePullAdapter({ characterNames: [] });

    await expect(new ChatPullService(adapter, new DriveService(drive)).pullChat('Alice', CHAT_ID)).rejects.toThrow('$.data');
    expect(adapter.calls.applied).toHaveLength(0);
    expect(adapter.calls.selected).toHaveLength(0);
    expect(adapter.calls.created).toHaveLength(0);
    expect(adapter.calls.meta).toHaveLength(0);
  });

  it('rejects malformed cloud JSONL before selecting a character or creating a chat', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const driveService = new DriveService(drive);
    const folderId = await driveService.ensureFolderPath(['SillyTavernSync', 'Alice', CHAT_ID, 'chat']);
    await drive.uploadText(folderId, '2099-01-01T00-00-00Z__bad.jsonl', '{"user_name":"U"}\n{"mes":');
    const adapter = fakePullAdapter({ characterNames: ['Alice'] });

    await expect(new ChatPullService(adapter, driveService).pullChat('Alice', CHAT_ID)).rejects.toThrow('無法解析');
    expect(adapter.calls.selected).toHaveLength(0);
    expect(adapter.calls.created).toHaveLength(0);
    expect(adapter.calls.meta).toHaveLength(0);
  });

  it('does not select or create when the user switches away and back during download', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const delayed = new DelayedPullDownloadDriveService(drive);
    const adapter = fakePullAdapter({ characterNames: ['Alice'] });

    const pull = new ChatPullService(adapter, delayed).pullChat('Alice', CHAT_ID);
    await delayed.downloadStarted;
    markContextChanged();
    markContextChanged();
    delayed.releaseDownload();

    await expect(pull).rejects.toThrow('已切換');
    expect(adapter.calls.selected).toHaveLength(0);
    expect(adapter.calls.created).toHaveLength(0);
    expect(adapter.calls.meta).toHaveLength(0);
  });
});

class DelayedPullDownloadDriveService extends DriveService {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly downloadStarted = new Promise<void>(resolve => {
    this.resolveStarted = resolve;
  });
  private release = new Promise<void>(resolve => {
    this.resolveRelease = resolve;
  });

  releaseDownload(): void {
    this.resolveRelease();
  }

  override async downloadText(fileId: string): Promise<string> {
    this.resolveStarted();
    await this.release;
    return super.downloadText(fileId);
  }
}

async function seedCloudChat(drive: MemoryDriveClient, roleKey: string, chatId: string) {
  const root = drive.forceCreateFolder('SillyTavernSync', null);
  const role = drive.forceCreateFolder(roleKey, root.id);
  const chat = drive.forceCreateFolder(chatId, role.id);
  const chatDir = drive.forceCreateFolder('chat', chat.id);
  await drive.uploadText(chatDir.id, '2026-06-25T14-45-00Z__A電腦.jsonl', 'old');
  await drive.uploadText(chatDir.id, '2026-06-26T09-00-00Z__B電腦.jsonl', RAW_JSONL);
  return { chatFolderId: chat.id };
}

function fakePullAdapter(input: {
  characterNames: string[];
  chatFiles?: string[];
  switchDuringSave?: string;
  switchAfterCreate?: string;
  exportedRawChat?: string;
}) {
  const calls = {
    selected: [] as string[],
    created: [] as Array<{ fileName: string; content: string }>,
    opened: [] as string[],
    applied: [] as CharacterSnapshot[],
    meta: [] as ChatSyncMeta[]
  };
  const adapter: TavernPullAdapter & {
    characterNames: string[];
    chatFiles: string[];
    calls: typeof calls;
    onApplyCharacter: ((snapshot: CharacterSnapshot) => void) | undefined;
    currentName: string | null;
    currentChatFileName: string | null;
    rawChat: string;
  } = {
    characterNames: [...input.characterNames],
    chatFiles: [...(input.chatFiles ?? [])],
    calls,
    onApplyCharacter: undefined,
    currentName: null,
    currentChatFileName: null,
    rawChat: RAW_JSONL,
    listCharacterNames() {
      return [...this.characterNames];
    },
    listCharacters() {
      return this.characterNames.map(name => ({ name, avatarUrl: `${name}.png` }));
    },
    async selectCharacter(character) {
      if (!this.characterNames.includes(character.name)) {
        throw new Error(`本地找不到角色卡：${character.name}`);
      }
      this.currentName = character.name;
      calls.selected.push(character.name);
    },
    async selectCharacterByName(name: string) {
      await this.selectCharacter({ name, avatarUrl: `${name}.png` });
    },
    getCurrentCharacterRef() {
      return this.currentName ? { name: this.currentName, avatarUrl: `${this.currentName}.png` } : null;
    },
    getCurrentCharacterName() {
      return this.currentName;
    },
    async listCharacterChatFiles() {
      return [...this.chatFiles];
    },
    async listCurrentCharacterChatFiles() {
      return [...this.chatFiles];
    },
    async createChatFile(_character, fileName: string, rawJsonl: string) {
      calls.created.push({ fileName, content: rawJsonl });
      this.rawChat = rawJsonl;
      if (input.switchDuringSave) this.currentChatFileName = input.switchDuringSave;
    },
    async openChatFile(_character, fileName: string) {
      calls.opened.push(fileName);
      this.currentChatFileName = input.switchAfterCreate ?? fileName;
    },
    async createAndOpenChatFile(fileName: string, rawJsonl: string) {
      if (!this.currentName) throw new Error('目前沒有角色');
      const character = { name: this.currentName, avatarUrl: `${this.currentName}.png` };
      await this.createChatFile(character, fileName, rawJsonl);
      await this.openChatFile(character, fileName);
    },
    getCurrentChatFileName() {
      return this.currentChatFileName;
    },
    async exportRawChat() {
      const content = input.exportedRawChat ?? this.rawChat;
      return { content, messageCount: Math.max(0, content.split(/\r?\n/).filter(Boolean).length - 1) };
    },
    async applyCharacter(snapshot: CharacterSnapshot) {
      calls.applied.push(snapshot);
      this.onApplyCharacter?.(snapshot);
    },
    writeChatMeta(meta: ChatSyncMeta) {
      calls.meta.push(meta);
    }
  };
  return adapter;
}

function stubScriptVariables() {
  const scriptStore: Record<string, unknown> = {
    tavern_roamer_settings: {
      deviceName: 'DeviceA',
      googleClientId: '',
      autoSyncEnabled: true,
      autoSyncEveryN: 1,
      chatRetention: { mode: 'keep_all', latestN: 10 }
    }
  };
  vi.stubGlobal('getVariables', ({ type }: { type: string }) => (type === 'script' ? scriptStore : {}));
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(scriptStore, value));
}

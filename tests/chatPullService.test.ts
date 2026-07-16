import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPullService, chatFileMatchesChatId, type TavernPullAdapter } from '../src/chat/ChatPullService';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import type { ChatSyncMeta } from '../src/types';
import type { CharacterSnapshot } from '../src/environment/types';

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

  it('rejects when a local chat with the same chat_id already exists', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    await seedCloudChat(drive, 'Alice', CHAT_ID);
    const adapter = fakePullAdapter({
      characterNames: ['Alice'],
      chatFiles: [`Alice - ${CHAT_ID}.jsonl`]
    });
    const service = new ChatPullService(adapter, new DriveService(drive));

    await expect(service.pullChat('Alice', CHAT_ID)).rejects.toThrow('下載並覆蓋');
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
});

async function seedCloudChat(drive: MemoryDriveClient, roleKey: string, chatId: string) {
  const root = drive.forceCreateFolder('SillyTavernSync', null);
  const role = drive.forceCreateFolder(roleKey, root.id);
  const chat = drive.forceCreateFolder(chatId, role.id);
  const chatDir = drive.forceCreateFolder('chat', chat.id);
  await drive.uploadText(chatDir.id, '2026-06-25T14-45-00Z__A電腦.jsonl', 'old');
  await drive.uploadText(chatDir.id, '2026-06-26T09-00-00Z__B電腦.jsonl', RAW_JSONL);
  return { chatFolderId: chat.id };
}

function fakePullAdapter(input: { characterNames: string[]; chatFiles?: string[] }) {
  const calls = {
    selected: [] as string[],
    created: [] as Array<{ fileName: string; content: string }>,
    applied: [] as CharacterSnapshot[],
    meta: [] as ChatSyncMeta[]
  };
  const adapter: TavernPullAdapter & {
    characterNames: string[];
    chatFiles: string[];
    calls: typeof calls;
    onApplyCharacter: ((snapshot: CharacterSnapshot) => void) | undefined;
    currentName: string | null;
  } = {
    characterNames: [...input.characterNames],
    chatFiles: [...(input.chatFiles ?? [])],
    calls,
    onApplyCharacter: undefined,
    currentName: null,
    listCharacterNames() {
      return [...this.characterNames];
    },
    async selectCharacterByName(name: string) {
      if (!this.characterNames.includes(name)) {
        throw new Error(`本地找不到角色卡：${name}`);
      }
      this.currentName = name;
      calls.selected.push(name);
    },
    getCurrentCharacterName() {
      return this.currentName;
    },
    async listCurrentCharacterChatFiles() {
      return [...this.chatFiles];
    },
    async createAndOpenChatFile(fileName: string, rawJsonl: string) {
      calls.created.push({ fileName, content: rawJsonl });
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSyncService, type TavernChatAdapter } from '../src/chat/ChatSyncService';
import { loadUploadQueue } from '../src/chat/queue';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { CHAT_META_KEY } from '../src/types';

describe('ChatSyncService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads current raw chat and keeps only latest N versions', async () => {
    stubScriptVariables({ chatRetention: { mode: 'keep_latest_n', latestN: 3 } });
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new ChatSyncService(adapter, new DriveService(drive));

    for (let index = 0; index < 4; index += 1) {
      adapter.messages.push({ message_id: index, role: 'user', message: String(index) });
      adapter.rawChat += `\n${JSON.stringify({ mes: String(index) })}`;
      await service.uploadCurrentChat();
    }

    const meta = adapter.variables[CHAT_META_KEY] as { role_key: string; chat_id: string };
    const versions = await new DriveService(drive).listVersions(['SillyTavernSync', meta.role_key, meta.chat_id, 'chat']);
    expect(versions).toHaveLength(3);
    expect(versions.every(version => version.filename.endsWith('.jsonl'))).toBe(true);
    expect((adapter.variables[CHAT_META_KEY] as { last_synced_version?: string }).last_synced_version).toBeTruthy();
  });

  it('queues failed raw uploads and flushes them later', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new ChatSyncService(adapter, new DriveService(drive));

    drive.injectError(503);
    const result = await service.uploadCurrentChat({ queueOnFail: true });
    expect(result.queued).toBe(true);
    expect(loadUploadQueue()).toHaveLength(1);

    const flushed = await service.flushQueue();
    expect(flushed.uploaded).toBe(1);
    expect(loadUploadQueue()).toHaveLength(0);
  });

  it('downloads latest raw version and replaces local chat after pre-restore backup', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new ChatSyncService(adapter, new DriveService(drive));

    await service.uploadCurrentChat();
    adapter.messages = [{ message_id: 0, role: 'user', message: 'changed' }];
    adapter.rawChat = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'changed' })}`;
    const filename = await service.downloadLatestAndReplace();

    expect(filename).toMatch(/\.jsonl$/);
    expect(adapter.rawChat).toContain('hello');
    expect(adapter.messages[0]?.message).toBe('hello');
  });
});

function stubScriptVariables(settingsOverrides: Record<string, unknown> = {}) {
  const scriptStore: Record<string, unknown> = {
    tavern_roamer_settings: {
      deviceName: 'DeviceA',
      googleClientId: '',
      autoSyncEnabled: true,
      autoSyncEveryN: 1,
      chatRetention: { mode: 'keep_latest_n', latestN: 10 },
      ...settingsOverrides
    }
  };
  vi.stubGlobal('getVariables', ({ type }: { type: string }) => (type === 'script' ? scriptStore : {}));
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(scriptStore, value));
}

function fakeAdapter(): TavernChatAdapter & {
  variables: Record<string, unknown>;
  messages: Array<Record<string, unknown> & { message_id: number }>;
  rawChat: string;
} {
  const adapter = {
    variables: {},
    messages: [{ message_id: 0, role: 'user', message: 'hello' }],
    rawChat: `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hello' })}`,
    getChatVariables() {
      return this.variables;
    },
    writeChatVariables(value: Record<string, unknown>) {
      Object.assign(this.variables, value);
    },
    getCurrentCharacterName() {
      return 'Role';
    },
    getCurrentChatFileName() {
      return 'Role - 2026-06-28@15h24m22s470ms.json';
    },
    getMessages() {
      return this.messages;
    },
    getChatWorldbook() {
      return 'Worldbook';
    },
    async exportRawChat() {
      return { content: this.rawChat, messageCount: this.messages.length };
    },
    async exportCharacter() {
      return { kind: 'character', exportedAt: new Date().toISOString(), characterName: 'Role', data: { ok: true } };
    },
    async exportWorld() {
      return {
        kind: 'world',
        exportedAt: new Date().toISOString(),
        bindings: { chat: 'Worldbook', char_primary: 'Worldbook', char_additional: [], global_enabled: [] },
        books: { Worldbook: { entries: [] } }
      };
    },
    async exportPersona() {
      return { kind: 'persona', exportedAt: new Date().toISOString(), name: 'Role', data: { ok: true } };
    },
    async exportPreset() {
      return { kind: 'preset', exportedAt: new Date().toISOString(), name: 'Preset', data: { ok: true } };
    },
    async exportRegex() {
      return { kind: 'regex', exportedAt: new Date().toISOString(), scope: 'global', items: [] };
    },
    async applyCharacter() {
      return undefined;
    },
    async applyWorld() {
      return undefined;
    },
    async applyPersona() {
      return undefined;
    },
    async applyPreset() {
      return undefined;
    },
    async applyRegex() {
      return undefined;
    },
    async replaceRawChat(content: string) {
      this.rawChat = content;
      this.messages = content
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(1)
        .map((line, index) => {
          const parsed = JSON.parse(line) as { mes?: string };
          return { message_id: index, role: 'assistant', message: parsed.mes ?? '' };
        });
    },
    async replaceChat(chatPackage) {
      this.messages = chatPackage.messages.map(message => ({ ...message }));
      this.variables = { ...chatPackage.chat_variables };
    }
  } satisfies TavernChatAdapter & {
    variables: Record<string, unknown>;
    messages: Array<Record<string, unknown> & { message_id: number }>;
    rawChat: string;
  };
  return adapter;
}

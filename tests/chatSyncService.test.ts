import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSyncService, driveChatPath, type TavernChatAdapter } from '../src/chat/ChatSyncService';
import { countQueuedUploadsForChat, loadUploadQueue } from '../src/chat/queue';
import { loadSyncReceipts } from '../src/chat/receipts';
import { loadRetentionQueue } from '../src/chat/retentionQueue';
import { DriveService } from '../src/drive/DriveService';
import { DriveError } from '../src/drive/DriveClient';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import type { TavernChatRef } from '../src/chat/context';
import { CHAT_META_KEY } from '../src/types';
import { markContextChanged } from '../src/contextRevision';
import { computeSyncStatus } from '../src/chat/status';

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
      const result = await service.uploadCurrentChat();
      expect([...result.path, result.filename].join(' / ')).toContain('SillyTavernSync / Role /');
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
    expect(countQueuedUploadsForChat({ chat_id: '2026-06-28@15h24m22s470ms', role_key: 'Role' })).toBe(1);
    expect(countQueuedUploadsForChat({ chat_id: 'other-chat', role_key: 'Role' })).toBe(0);

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
    const result = await service.downloadLatestAndReplace();

    expect(result).toMatchObject({ status: 'done', metadata: 'applied' });
    expect(result.filename).toMatch(/\.jsonl$/);
    expect(adapter.rawChat).toContain('hello');
    expect(adapter.messages[0]?.message).toBe('hello');
  });

  it('checks the latest supported raw version by Drive creation order and reports whether the baseline still exists', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const service = new ChatSyncService(adapter, driveService);
    const meta = service.ensureSyncMeta();
    const folderId = await driveService.ensureFolderPath(driveChatPath(meta));
    const baseline = await driveService.uploadText(folderId, '2030-01-01T00-00-00Z__ClockAhead.jsonl', adapter.rawChat);
    const unsupported = await driveService.uploadJson(folderId, '2040-01-01T00-00-00Z__Package.json', { ignored: true });
    const newer = await driveService.uploadText(folderId, '2025-01-01T00-00-00Z__ActuallyNewer.jsonl', adapter.rawChat);
    drive.forceSetTimes(baseline.id, '2026-01-01T00:00:00Z');
    drive.forceSetTimes(unsupported.id, '2026-01-01T00:02:00Z');
    drive.forceSetTimes(newer.id, '2026-01-01T00:01:00Z');

    expect(await service.getRemoteVersionState({
      ...meta,
      last_synced_version: baseline.name
    })).toEqual({
      latestFilename: newer.name,
      baselineFound: true
    });
  });

  it('records the downloaded version when replacing the chat triggers a same-chat reload', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const service = new ChatSyncService(adapter, driveService);

    await service.uploadCurrentChat();
    const meta = adapter.variables[CHAT_META_KEY] as { chat_id: string; role_key: string };
    const remoteContent = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'new remote content' })}`;
    const remoteFilename = '2099-01-01T00-00-00Z__OtherDevice.jsonl';
    const folderId = await driveService.ensureFolderPath(driveChatPath(meta));
    await driveService.uploadText(folderId, remoteFilename, remoteContent);

    adapter.rawChat = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'local content' })}`;
    const replaceRawChat = adapter.replaceRawChat.bind(adapter);
    adapter.replaceRawChat = async (content, ref) => {
      await replaceRawChat(content, ref);
      markContextChanged();
    };

    expect(await service.downloadLatestAndReplace()).toMatchObject({
      filename: remoteFilename,
      status: 'done',
      metadata: 'applied'
    });
    expect(adapter.variables[CHAT_META_KEY]).toMatchObject({
      last_synced_version: remoteFilename
    });
    expect(loadSyncReceipts()).toHaveLength(0);
    const updatedMeta = adapter.variables[CHAT_META_KEY] as NonNullable<Parameters<typeof computeSyncStatus>[0]['meta']>;
    expect(computeSyncStatus({
      connected: true,
      meta: updatedMeta,
      remoteLatestFilename: await service.getLatestRemoteFilename(updatedMeta),
      localMessageCount: adapter.messages.length,
      localContentHash: await service.getCurrentContentHash()
    })).toBe('synced');
  });

  it('reports a partial download when content was replaced but sync metadata could not be written', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const service = new ChatSyncService(adapter, driveService);

    await service.uploadCurrentChat();
    const meta = adapter.variables[CHAT_META_KEY] as { chat_id: string; role_key: string };
    const remoteFilename = '2099-01-01T00-00-00Z__OtherDevice.jsonl';
    const remoteContent = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'remote replacement' })}`;
    const folderId = await driveService.ensureFolderPath(driveChatPath(meta));
    await driveService.uploadText(folderId, remoteFilename, remoteContent);
    adapter.writeChatVariables = () => {
      throw new Error('metadata write failed');
    };

    const result = await service.downloadLatestAndReplace();

    expect(result).toEqual({ filename: remoteFilename, status: 'partial', metadata: 'failed' });
    expect(adapter.rawChat).toContain('remote replacement');
  });

  it('does not write upload metadata into a chat opened while the upload is in flight', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const delayed = new DelayedUploadDriveService(drive);
    const service = new ChatSyncService(adapter, delayed);

    const upload = service.uploadCurrentChat({ queueOnFail: true });
    await delayed.uploadStarted;
    adapter.currentRef = chatRef('B');
    adapter.variables = { [CHAT_META_KEY]: { chat_id: 'B', role_key: 'RoleB' } };
    delayed.releaseUpload();

    const result = await upload;
    expect(result.queued).toBe(false);
    expect(result.metadata).toBe('deferred');
    expect(adapter.variables[CHAT_META_KEY]).toEqual({ chat_id: 'B', role_key: 'RoleB' });
    expect(loadSyncReceipts()).toHaveLength(1);

    adapter.currentRef = chatRef('A');
    adapter.variables = {};
    expect(await service.applyPendingReceiptsForCurrent()).toBe(1);
    expect(adapter.variables[CHAT_META_KEY]).toMatchObject({
      chat_id: '2026-06-28@15h24m22s470ms',
      last_synced_version: result.filename
    });
  });

  it('reports cleanup separately and never requeues an upload that reached Drive', async () => {
    stubScriptVariables({ chatRetention: { mode: 'keep_latest_n', latestN: 1 } });
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const flakyCleanup = new FlakyCleanupDriveService(drive);
    const service = new ChatSyncService(adapter, flakyCleanup);

    await service.uploadCurrentChat();
    flakyCleanup.failNextDelete = true;
    const result = await service.uploadCurrentChat({ queueOnFail: true });

    expect(result.queued).toBe(false);
    expect(result.cleanup).toBe('pending');
    expect(loadUploadQueue()).toHaveLength(0);
    expect(loadRetentionQueue()).toHaveLength(1);

    await service.flushQueue();
    expect(loadRetentionQueue()).toHaveLength(0);
    expect(await flakyCleanup.listVersions(result.path)).toHaveLength(1);
  });

  it('reuses the generated Drive ID after an ambiguous upload response', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const ambiguous = new AmbiguousUploadDriveService(drive);
    const service = new ChatSyncService(adapter, ambiguous);

    const result = await service.uploadCurrentChat({ queueOnFail: true });
    expect(result.queued).toBe(true);
    expect(loadUploadQueue()).toHaveLength(1);

    const flushed = await service.flushQueue();
    expect(flushed).toEqual({ uploaded: 1, remaining: 0 });
    expect(await ambiguous.listVersions(result.path)).toHaveLength(1);
  });

  it('aborts a download before the pre-restore backup when the user switches chats', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    await new ChatSyncService(adapter, new DriveService(drive)).uploadCurrentChat();
    const delayed = new DelayedDownloadDriveService(drive);
    const service = new ChatSyncService(adapter, delayed);
    const replaceRawChat = vi.spyOn(adapter, 'replaceRawChat');

    const download = service.downloadLatestAndReplace();
    await delayed.downloadStarted;
    adapter.currentRef = chatRef('B');
    adapter.variables = { [CHAT_META_KEY]: { chat_id: 'B', role_key: 'RoleB' } };
    delayed.releaseDownload();

    await expect(download).rejects.toThrow('聊天已切換');
    expect(replaceRawChat).not.toHaveBeenCalled();
    expect(drive.snapshot().filter(item => item.name === '_pre_restore')).toHaveLength(0);
  });

  it('aborts a download when the user switches away and back to the same chat', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    await new ChatSyncService(adapter, new DriveService(drive)).uploadCurrentChat();
    const delayed = new DelayedDownloadDriveService(drive);
    const service = new ChatSyncService(adapter, delayed);
    const replaceRawChat = vi.spyOn(adapter, 'replaceRawChat');

    const download = service.downloadLatestAndReplace();
    await delayed.downloadStarted;
    adapter.currentRef = chatRef('B');
    markContextChanged();
    adapter.currentRef = chatRef('A');
    markContextChanged();
    delayed.releaseDownload();

    await expect(download).rejects.toThrow('聊天已切換');
    expect(replaceRawChat).not.toHaveBeenCalled();
    expect(drive.snapshot().filter(item => item.name === '_pre_restore')).toHaveLength(0);
  });

  it('does not replace a chat edited while its pre-restore backup is uploading', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    await new ChatSyncService(adapter, new DriveService(drive)).uploadCurrentChat();
    adapter.rawChat = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'cat' })}`;
    const delayed = new DelayedPreRestoreDriveService(drive);
    const service = new ChatSyncService(adapter, delayed);
    const replaceRawChat = vi.spyOn(adapter, 'replaceRawChat');

    const download = service.downloadLatestAndReplace();
    await delayed.uploadStarted;
    adapter.rawChat = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'dog' })}`;
    delayed.releaseUpload();

    await expect(download).rejects.toThrow('本地聊天內容已變更');
    expect(replaceRawChat).not.toHaveBeenCalled();
    expect(adapter.rawChat).toContain('dog');
  });
});

class DelayedUploadDriveService extends DriveService {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly uploadStarted = new Promise<void>(resolve => {
    this.resolveStarted = resolve;
  });
  private release = new Promise<void>(resolve => {
    this.resolveRelease = resolve;
  });

  releaseUpload(): void {
    this.resolveRelease();
  }

  override async uploadText(folderId: string, filename: string, content: string, mimeType?: string, fileId?: string) {
    this.resolveStarted();
    await this.release;
    return super.uploadText(folderId, filename, content, mimeType, fileId);
  }
}

class FlakyCleanupDriveService extends DriveService {
  failNextDelete = false;

  override async deleteFile(fileId: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('cleanup failed');
    }
    return super.deleteFile(fileId);
  }
}

class AmbiguousUploadDriveService extends DriveService {
  private loseFirstResponse = true;

  override async uploadText(folderId: string, filename: string, content: string, mimeType?: string, fileId?: string) {
    const result = await super.uploadText(folderId, filename, content, mimeType, fileId);
    if (this.loseFirstResponse) {
      this.loseFirstResponse = false;
      throw new DriveError('response lost after upload', 503, 'ambiguous_result');
    }
    return result;
  }
}

class DelayedDownloadDriveService extends DriveService {
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

class DelayedPreRestoreDriveService extends DriveService {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly uploadStarted = new Promise<void>(resolve => {
    this.resolveStarted = resolve;
  });
  private release = new Promise<void>(resolve => {
    this.resolveRelease = resolve;
  });

  releaseUpload(): void {
    this.resolveRelease();
  }

  override async uploadText(folderId: string, filename: string, content: string, mimeType?: string, fileId?: string) {
    this.resolveStarted();
    await this.release;
    return super.uploadText(folderId, filename, content, mimeType, fileId);
  }
}

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
  currentRef: TavernChatRef;
} {
  const adapter = {
    variables: {},
    messages: [{ message_id: 0, role: 'user', message: 'hello' }],
    rawChat: `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hello' })}`,
    currentRef: chatRef('A'),
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
      return this.currentRef.displayFileName;
    },
    getCurrentChatRef() {
      return this.currentRef;
    },
    isCurrentChat(ref: TavernChatRef) {
      return this.currentRef.nativeChatId === ref.nativeChatId && this.currentRef.avatarUrl === ref.avatarUrl;
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
    currentRef: TavernChatRef;
  };
  return adapter;
}

function chatRef(id: string): TavernChatRef {
  const timestamp = id === 'A' ? '2026-06-28@15h24m22s470ms' : '2026-06-29@15h24m22s470ms';
  return {
    nativeChatId: `Role - ${timestamp}`,
    rawFileName: `Role - ${timestamp}.jsonl`,
    displayFileName: `Role - ${timestamp}.json`,
    avatarUrl: `${id}.png`
  };
}

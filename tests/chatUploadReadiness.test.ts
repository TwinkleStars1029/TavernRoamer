import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatUploadReadinessService } from '../src/chat/ChatUploadReadinessService';
import { driveChatPath } from '../src/chat/ChatSyncService';
import type { ChatSyncTarget } from '../src/chat/context';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { environmentItemPath } from '../src/environment/EnvironmentBackupService';

describe('ChatUploadReadinessService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats a chat without a usable JSONL version as a first upload', async () => {
    stubVariables();
    const drive = new DriveService(new MemoryDriveClient());
    const target = makeTarget();
    const folder = await drive.ensureFolderPath(driveChatPath(target.meta));
    await drive.uploadText(folder, '2026-10-19T01-00-00Z__device.json', '{}');

    const result = await new ChatUploadReadinessService(drive).inspect(target);

    expect(result.isFirstUpload).toBe(true);
    expect(result.latestChatFilename).toBeNull();
    expect(result.recoveryStatus).toBe('first_upload');
  });

  it('reports ready when both a chat version and character backup exist', async () => {
    stubVariables();
    const drive = new DriveService(new MemoryDriveClient());
    const target = makeTarget();
    const chatFolder = await drive.ensureFolderPath(driveChatPath(target.meta));
    const characterFolder = await drive.ensureFolderPath(environmentItemPath(target.meta, 'character'));
    await drive.uploadText(chatFolder, '2026-10-19T01-00-00Z__device.jsonl', '{}');
    await drive.uploadJson(characterFolder, '2026-10-19T01-00-00Z__device.json', { kind: 'character' });

    const result = await new ChatUploadReadinessService(drive).inspect(target);

    expect(result.isFirstUpload).toBe(false);
    expect(result.recoveryStatus).toBe('ready');
    expect(result.environment.find(item => item.kind === 'character')).toMatchObject({
      available: true,
      latestFilename: '2026-10-19T01-00-00Z__device.json'
    });
  });

  it('flags an existing remote chat that still lacks its character backup', async () => {
    stubVariables();
    const drive = new DriveService(new MemoryDriveClient());
    const target = makeTarget();
    const chatFolder = await drive.ensureFolderPath(driveChatPath(target.meta));
    await drive.uploadText(chatFolder, '2026-10-19T01-00-00Z__device.jsonl', '{}');

    const result = await new ChatUploadReadinessService(drive).inspect(target);

    expect(result.recoveryStatus).toBe('missing_character');
  });
});

function makeTarget(): ChatSyncTarget {
  return {
    operationId: 'op-1',
    key: 'role/chat',
    contextRevision: 1,
    ref: { nativeChatId: 'chat', rawFileName: 'chat.jsonl', displayFileName: 'chat', avatarUrl: 'role.png' },
    meta: { role_key: 'Role', chat_id: 'chat' }
  };
}

function stubVariables(): void {
  const variables: Record<string, unknown> = {};
  vi.stubGlobal('getVariables', () => variables);
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(variables, value));
}

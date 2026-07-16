import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCloudChats, listCloudRoles } from '../src/chat/browse';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';

describe('cloud browse', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists role folders excluding functional folders', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const root = drive.forceCreateFolder('SillyTavernSync', null);
    drive.forceCreateFolder('Alice', root.id);
    drive.forceCreateFolder('_self_check', root.id);

    const roles = await listCloudRoles(new DriveService(drive));
    expect(roles.map(role => role.roleKey)).toEqual(['Alice']);
  });

  it('lists chats with latest version info, newest chat first', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const root = drive.forceCreateFolder('SillyTavernSync', null);
    const role = drive.forceCreateFolder('Alice', root.id);

    const chatOld = drive.forceCreateFolder('2026-06-28@15h24m22s470ms', role.id);
    const chatOldDir = drive.forceCreateFolder('chat', chatOld.id);
    await drive.uploadText(chatOldDir.id, '2026-06-25T14-45-00Z__A電腦.jsonl', '{}');
    await drive.uploadText(chatOldDir.id, '2026-06-26T09-00-00Z__B電腦.jsonl', '{}');
    drive.forceCreateFolder('_pre_restore', chatOld.id);

    drive.forceCreateFolder('2026-07-01@08h00m00s000ms', role.id); // 沒有 chat/ 子資料夾的空窗

    const chats = await listCloudChats(new DriveService(drive), 'Alice');
    expect(chats).toHaveLength(2);
    expect(chats[0]?.chatId).toBe('2026-06-28@15h24m22s470ms');
    expect(chats[0]?.versionCount).toBe(2);
    expect(chats[0]?.latest?.device).toBe('B電腦');
    expect(chats[1]?.chatId).toBe('2026-07-01@08h00m00s000ms');
    expect(chats[1]?.versionCount).toBe(0);
    expect(chats[1]?.latest).toBeNull();
  });

  it('returns empty arrays for empty cloud', async () => {
    stubScriptVariables();
    const service = new DriveService(new MemoryDriveClient());
    expect(await listCloudRoles(service)).toEqual([]);
    expect(await listCloudChats(service, 'Nobody')).toEqual([]);
  });
});

function stubScriptVariables() {
  const scriptStore: Record<string, unknown> = {};
  vi.stubGlobal('getVariables', ({ type }: { type: string }) => (type === 'script' ? scriptStore : {}));
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(scriptStore, value));
}

import { describe, expect, it } from 'vitest';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { RestorePointService } from '../src/restorePoints/RestorePointService';

describe('RestorePointService', () => {
  it('indexes every chat with _pre_restore without depending on the active chat', async () => {
    const drive = new MemoryDriveClient();
    const root = drive.forceCreateFolder('SillyTavernSync', null);
    const roleA = drive.forceCreateFolder('RoleA', root.id);
    const roleB = drive.forceCreateFolder('RoleB', root.id);
    const chatA = drive.forceCreateFolder('ChatA', roleA.id);
    const chatB = drive.forceCreateFolder('ChatB', roleB.id);
    const restoreA = drive.forceCreateFolder('_pre_restore', chatA.id);
    drive.forceCreateFolder('2026-10-01T01-01-00Z', restoreA.id);
    drive.forceCreateFolder('_pre_restore', chatB.id);

    const chats = await service(drive).listChats();

    expect(chats).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleKey: 'RoleA', chatId: 'ChatA', batchCount: 1, latestCreatedAt: '2026-10-01T01:01:00.000Z' }),
      expect.objectContaining({ roleKey: 'RoleB', chatId: 'ChatB', batchCount: 0, latestCreatedAt: null })
    ]));
  });

  it('lists files, empty folders, and unknown content with creation and upload times', async () => {
    const drive = new MemoryDriveClient();
    const { batch, preRestore } = createRestorePointTree(drive);
    const direct = await drive.uploadText(batch.id, '2026-10-01T01-01-02Z__A.jsonl', '{}');
    const loose = await drive.uploadText(preRestore.id, 'loose.jsonl', '{}');
    const character = drive.forceCreateFolder('character', batch.id);
    const nested = await drive.uploadJson(character.id, 'character.json', { kind: 'character' });
    drive.forceCreateFolder('mystery', batch.id);
    const emptyKnown = drive.forceCreateFolder('world', batch.id);
    drive.forceSetTimes(direct.id, '2026-10-01T01:01:02.000Z');
    drive.forceSetTimes(nested.id, '2026-10-01T01:01:03.000Z');

    const batches = await service(drive).listChat({ roleKey: 'RoleA', chatId: 'ChatA' });

    expect(batches).toHaveLength(2);
    const timestampBatch = batches.find(item => item.folderId === batch.id);
    expect(timestampBatch).toMatchObject({
      roleKey: 'RoleA',
      chatId: 'ChatA',
      name: '2026-10-01T01-01-00Z',
      createdAt: '2026-10-01T01:01:00.000Z',
      issues: ['unknown_items']
    });
    expect(timestampBatch?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileId: direct.id, kind: 'chat', relativePath: direct.name, uploadedAt: '2026-10-01T01:01:02.000Z' }),
      expect.objectContaining({ fileId: nested.id, kind: 'character', relativePath: `character/${nested.name}`, uploadedAt: '2026-10-01T01:01:03.000Z' })
    ]));
    expect(timestampBatch?.emptyFolders).toEqual(expect.arrayContaining([
      expect.objectContaining({ folderId: emptyKnown.id, relativePath: 'world', empty: true }),
      expect.objectContaining({ relativePath: 'mystery', empty: true })
    ]));
    expect(batches.find(item => item.folderId === preRestore.id)?.files).toEqual([
      expect.objectContaining({ fileId: loose.id, relativePath: 'loose.jsonl' })
    ]);
  });

  it('moves selected files to trash and rejects a mismatched conversation scope', async () => {
    const drive = new MemoryDriveClient();
    const { batch, otherChat } = createRestorePointTree(drive);
    const selected = await drive.uploadText(batch.id, 'selected.jsonl', '{}');
    const outsideRoot = drive.forceCreateFolder('_pre_restore', otherChat.id);
    const outsideBatch = drive.forceCreateFolder('2026-09-01T00-00-00Z', outsideRoot.id);
    const outside = await drive.uploadText(outsideBatch.id, 'outside.jsonl', '{}');
    const restorePoints = service(drive);

    await expect(restorePoints.trashFiles([
      { fileId: outside.id, roleKey: 'RoleA', chatId: 'ChatA' }
    ])).rejects.toThrow('不屬於指定的 _pre_restore');

    const result = await restorePoints.trashFiles([
      { fileId: selected.id, roleKey: 'RoleA', chatId: 'ChatA' }
    ]);

    expect(result).toEqual({ requested: 1, affected: 1, failed: [] });
    expect(drive.snapshot().find(item => item.id === selected.id)?.trashed).toBe(true);
    expect(drive.snapshot().find(item => item.id === outside.id)?.trashed).not.toBe(true);
  });

  it('previews global age cleanup before changing any remote file', async () => {
    const drive = new MemoryDriveClient();
    const { batch, otherChat } = createRestorePointTree(drive);
    const old = await drive.uploadText(batch.id, 'old.jsonl', '{}');
    const recent = await drive.uploadText(batch.id, 'recent.jsonl', '{}');
    const outsideRoot = drive.forceCreateFolder('_pre_restore', otherChat.id);
    const outsideBatch = drive.forceCreateFolder('2026-09-01T00-00-00Z', outsideRoot.id);
    const outsideOld = await drive.uploadText(outsideBatch.id, 'outside-old.jsonl', '{}');
    drive.forceSetTimes(old.id, '2026-09-01T00:00:00.000Z');
    drive.forceSetTimes(recent.id, '2026-10-10T00:00:00.000Z');
    drive.forceSetTimes(outsideOld.id, '2026-08-01T00:00:00.000Z');

    const preview = await service(drive).previewCleanup(30, undefined, new Date('2026-10-19T00:00:00.000Z'));

    expect(preview).toMatchObject({ scope: 'all', roleCount: 1, chatCount: 2, batchCount: 2 });
    expect(preview.targets.map(item => item.fileId)).toEqual(expect.arrayContaining([old.id, outsideOld.id]));
    expect(preview.targets.map(item => item.fileId)).not.toContain(recent.id);
    expect(drive.snapshot().some(item => item.trashed)).toBe(false);
  });
});

function createRestorePointTree(drive: MemoryDriveClient) {
  const root = drive.forceCreateFolder('SillyTavernSync', null);
  const role = drive.forceCreateFolder('RoleA', root.id);
  const chat = drive.forceCreateFolder('ChatA', role.id);
  const otherChat = drive.forceCreateFolder('ChatB', role.id);
  const preRestore = drive.forceCreateFolder('_pre_restore', chat.id);
  const batch = drive.forceCreateFolder('2026-10-01T01-01-00Z', preRestore.id);
  return { root, role, chat, otherChat, preRestore, batch };
}

function service(drive: MemoryDriveClient) {
  return new RestorePointService(new DriveService(drive));
}

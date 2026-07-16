import { describe, expect, it } from 'vitest';
import { DriveError } from '../src/drive/DriveClient';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';

describe('MemoryDriveClient', () => {
  it('creates folders once and stores JSON files', async () => {
    const drive = new MemoryDriveClient();

    const root = await drive.ensureFolder('SillyTavernSync', null);
    const sameRoot = await drive.ensureFolder('SillyTavernSync', null);
    const chatFolder = await drive.ensureFolder('chat', root.id);
    const file = await drive.uploadJson(chatFolder.id, 'version.json', { hello: 'world' });

    await expect(drive.downloadJson(file.id)).resolves.toEqual({ hello: 'world' });
    await expect(drive.listFiles(chatFolder.id)).resolves.toHaveLength(1);
    expect(sameRoot.id).toBe(root.id);
  });

  it('can inject transient Drive API errors', async () => {
    const drive = new MemoryDriveClient();
    drive.injectError(401);

    await expect(drive.ensureFolder('x', null)).rejects.toBeInstanceOf(DriveError);
    await expect(drive.ensureFolder('x', null)).resolves.toMatchObject({ name: 'x' });
  });
});

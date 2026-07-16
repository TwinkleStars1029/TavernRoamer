import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveError } from '../src/drive/DriveClient';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';

describe('DriveService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses existing folders and caches resolved folder ids', async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('getVariables', () => store);
    vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(store, value));

    const client = new MemoryDriveClient();
    const service = new DriveService(client);
    const first = await service.ensureFolderPath(['SillyTavernSync', '角色', 'chat_1']);
    const second = await service.ensureFolderPath(['SillyTavernSync', '角色', 'chat_1']);

    expect(second).toBe(first);
    expect(client.snapshot().filter(item => item.type === 'folder' && item.name === 'chat_1')).toHaveLength(1);
  });

  it('invalidates folder cache on 404 and resolves again', async () => {
    const store: Record<string, unknown> = {
      tavern_roamer_settings: {},
      drive_folder_cache: { 'SillyTavernSync/角色/chat_1': 'missing' }
    };
    vi.stubGlobal('getVariables', () => store);
    vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(store, value));

    const service = new DriveService(new MemoryDriveClient());
    const folderId = await service.ensureFolderPath(['SillyTavernSync', '角色', 'chat_1']);

    expect(folderId).not.toBe('missing');
  });

  it('creates missing intermediate folders one level at a time', async () => {
    const client = new MemoryDriveClient();
    const root = await client.ensureFolder('SillyTavernSync', null);
    const service = new DriveService(client);

    const folderId = await service.ensureFolderPath(['SillyTavernSync', 'role_a', 'chat_a', 'chat']);
    const snapshot = client.snapshot().filter(item => item.type === 'folder');

    expect(folderId).toBeTruthy();
    expect(snapshot.some(item => item.name === 'SillyTavernSync' && item.parentId === null)).toBe(true);
    expect(snapshot.some(item => item.name === 'role_a' && item.parentId === root.id)).toBe(true);

    const roleFolder = snapshot.find(item => item.name === 'role_a' && item.parentId === root.id);
    expect(snapshot.some(item => item.name === 'chat_a' && item.parentId === roleFolder?.id)).toBe(true);

    const chatFolder = snapshot.find(item => item.name === 'chat_a' && item.parentId === roleFolder?.id);
    expect(snapshot.some(item => item.name === 'chat' && item.parentId === chatFolder?.id)).toBe(true);
  });

  it('lists the union of versions from duplicate same-name folders', async () => {
    const client = new MemoryDriveClient();
    const service = new DriveService(client);
    const root = client.forceCreateFolder('SillyTavernSync', null);
    const role = client.forceCreateFolder('角色', root.id);
    const chatA = client.forceCreateFolder('chat_1', role.id);
    const chatB = client.forceCreateFolder('chat_1', role.id);
    const folderA = client.forceCreateFolder('chat', chatA.id);
    const folderB = client.forceCreateFolder('chat', chatB.id);
    await client.uploadJson(folderA.id, '2026-06-25T14-45-00Z__A.json', { a: true });
    await client.uploadJson(folderB.id, '2026-06-25T14-46-00Z__B.json', { b: true });
    await client.uploadJson(folderB.id, 'bad-name.json', { ignored: true });

    const versions = await service.listVersions(['SillyTavernSync', '角色', 'chat_1', 'chat']);

    expect(versions.map(version => version.device)).toEqual(['A', 'B']);
  });

  it('throws a DriveError for empty paths', async () => {
    const service = new DriveService(new MemoryDriveClient());
    await expect(service.ensureFolderPath([])).rejects.toBeInstanceOf(DriveError);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';

describe('DriveService.listChildFolders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists folders under a path and unions duplicate parents', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const rootA = drive.forceCreateFolder('SillyTavernSync', null);
    const rootB = drive.forceCreateFolder('SillyTavernSync', null); // 手冊 6.2 併發重複資料夾情境
    drive.forceCreateFolder('RoleA', rootA.id);
    drive.forceCreateFolder('RoleB', rootB.id);

    const folders = await new DriveService(drive).listChildFolders(['SillyTavernSync']);
    expect(folders.map(folder => folder.name)).toEqual(['RoleA', 'RoleB']);
  });

  it('returns empty list when the path does not exist', async () => {
    stubScriptVariables();
    const service = new DriveService(new MemoryDriveClient());
    expect(await service.listChildFolders(['SillyTavernSync'])).toEqual([]);
  });

  it('lists only folders, not files', async () => {
    stubScriptVariables();
    const drive = new MemoryDriveClient();
    const root = drive.forceCreateFolder('SillyTavernSync', null);
    drive.forceCreateFolder('RoleA', root.id);
    await drive.uploadText(root.id, 'stray.txt', 'x');

    const folders = await new DriveService(drive).listChildFolders(['SillyTavernSync']);
    expect(folders.map(folder => folder.name)).toEqual(['RoleA']);
  });
});

function stubScriptVariables() {
  const scriptStore: Record<string, unknown> = {};
  vi.stubGlobal('getVariables', ({ type }: { type: string }) => (type === 'script' ? scriptStore : {}));
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(scriptStore, value));
}

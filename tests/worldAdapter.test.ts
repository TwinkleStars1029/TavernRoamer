import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernServices } from '../src/tavern';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { EnvironmentBackupService } from '../src/environment/EnvironmentBackupService';
import { EnvironmentRestoreService } from '../src/environment/EnvironmentRestoreService';
import type { WorldSnapshot } from '../src/environment/types';

const emptyBindings = { chat: null, char_primary: null, char_additional: [], global_enabled: [] };

describe('Tavern worldbook adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['key', 'keysecondary'])('backs up raw entries missing %s without triggering Helper conversion', async missingKey => {
    const entry: Record<string, unknown> = {
      uid: 7, comment: 'Legacy entry', content: 'Original content',
      key: ['/dragon/i'], keysecondary: [],
      extensions: { custom: { enabled: false } }
    };
    delete entry[missingKey];
    const raw = { entries: { 7: entry }, extensions: { custom: 'keep this too' } };
    // Reproduce the unchecked keyword conversion in Tavern Helper's toWorldbookEntry.
    const getWorldbook = vi.fn(async () => (entry[missingKey] as string[]).map(value => value));
    await expect(getWorldbook()).rejects.toThrow("Cannot read properties of undefined (reading 'map')");
    getWorldbook.mockClear();
    vi.stubGlobal('getWorldbook', getWorldbook);
    const loadWorldInfo = vi.fn(async () => raw);
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo }) });
    vi.stubGlobal('getChatWorldbookName', () => 'Legacy Book');

    const snapshot = await createTavernServices().environment.exportWorld();

    expect(snapshot.format).toBe('sillytavern-worldinfo-v1');
    expect(snapshot.books['Legacy Book']).toEqual(raw);
    expect(snapshot.books['Legacy Book']).not.toBe(raw);
    expect(JSON.parse(JSON.stringify(snapshot)).books['Legacy Book']).toEqual(raw);
    expect(raw.entries[7]).not.toHaveProperty(missingKey);
    expect(loadWorldInfo).toHaveBeenCalledWith('Legacy Book');
    expect(getWorldbook).not.toHaveBeenCalled();
  });

  it('includes chat, primary, additional and global books, reading overlapping books once', async () => {
    vi.stubGlobal('getChatWorldbookName', () => 'Chat');
    vi.stubGlobal('getCharWorldbookNames', () => ({ primary: 'Primary', additional: ['Extra', 'Chat', ''] }));
    vi.stubGlobal('getGlobalWorldbookNames', () => ['Global', 'Extra']);
    const loadWorldInfo = vi.fn(async () => ({ entries: {} }));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo }) });

    const snapshot = await createTavernServices().environment.exportWorld();

    expect(snapshot.bindings).toEqual({
      chat: 'Chat', char_primary: 'Primary', char_additional: ['Extra', 'Chat'], global_enabled: ['Global', 'Extra']
    });
    expect(Object.keys(snapshot.books)).toEqual(['Chat', 'Primary', 'Extra', 'Global']);
    expect(loadWorldInfo).toHaveBeenCalledTimes(4);
  });

  it('keeps additional bindings when a character has no primary book', async () => {
    vi.stubGlobal('getCharWorldbookNames', () => ({ primary: null, additional: ['Extra'] }));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo: async () => ({ entries: {} }) }) });

    const snapshot = await createTavernServices().environment.exportWorld();

    expect(snapshot.bindings).toEqual({ ...emptyBindings, char_additional: ['Extra'] });
    expect(Object.keys(snapshot.books)).toEqual(['Extra']);
  });

  it.each([undefined, null, {}, { primary: null }])('handles empty or incomplete bindings: %j', async characterBindings => {
    vi.stubGlobal('getCharWorldbookNames', () => characterBindings);
    vi.stubGlobal('getChatWorldbookName', () => undefined);
    vi.stubGlobal('getGlobalWorldbookNames', () => undefined);
    const loadWorldInfo = vi.fn();
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo }) });

    const snapshot = await createTavernServices().environment.exportWorld();

    expect(snapshot.bindings).toEqual(emptyBindings);
    expect(snapshot.books).toEqual({});
    expect(loadWorldInfo).not.toHaveBeenCalled();
  });

  it('supports older hosts using Helper entry arrays and array bindings', async () => {
    vi.stubGlobal('getCharWorldbookNames', () => ['Primary', 'Extra']);
    const entries = [{ uid: 1, name: 'Entry', content: 'Content' }];
    vi.stubGlobal('getWorldbook', async () => entries);
    const createOrReplaceWorldbook = vi.fn();
    vi.stubGlobal('createOrReplaceWorldbook', createOrReplaceWorldbook);
    const adapter = createTavernServices().environment;

    const snapshot = await adapter.exportWorld();
    await adapter.applyWorld(JSON.parse(JSON.stringify(snapshot)));

    expect(snapshot.format).toBe('tavern-helper-worldbook-v1');
    expect(snapshot.bindings).toEqual({ ...emptyBindings, char_primary: 'Primary', char_additional: ['Extra'] });
    expect(createOrReplaceWorldbook).toHaveBeenCalledWith('Primary', entries);
    expect(createOrReplaceWorldbook).toHaveBeenCalledWith('Extra', entries);
  });

  it.each([undefined, null, {}, { entries: [] }, { entries: { 1: null } }])('rejects unreadable raw data instead of backing up an empty book: %j', async data => {
    vi.stubGlobal('getChatWorldbookName', () => 'Broken Book');
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo: async () => data }) });
    const getWorldbook = vi.fn();
    vi.stubGlobal('getWorldbook', getWorldbook);

    await expect(createTavernServices().environment.exportWorld()).rejects.toThrow('無法讀取世界書「Broken Book」');
    expect(getWorldbook).not.toHaveBeenCalled();
  });

  it('includes the book name and original cause if an older Helper fails', async () => {
    const cause = new TypeError("Cannot read properties of undefined (reading 'map')");
    vi.stubGlobal('getChatWorldbookName', () => 'Broken Book');
    vi.stubGlobal('getWorldbook', async () => { throw cause; });

    await expect(createTavernServices().environment.exportWorld()).rejects.toMatchObject({
      message: `無法讀取世界書「Broken Book」：${cause.message}`, cause
    });
  });

  it('restores raw JSON, waits for saves and refreshes the book list before rebinding the chat', async () => {
    const calls: string[] = [];
    const data = { entries: { 1: { uid: 1, content: 'No keyword arrays', extension: false } }, custom: 'preserve' };
    const saveWorldInfo = vi.fn(async (_name: string, _data: unknown, _immediately: boolean) => { calls.push('save'); });
    const updateWorldInfoList = vi.fn(async () => { calls.push('list'); });
    const reloadWorldInfoEditor = vi.fn(async () => { calls.push('editor'); });
    const rebindChatWorldbook = vi.fn(async () => { calls.push('bind'); });
    vi.stubGlobal('SillyTavern', { getContext: () => ({ saveWorldInfo, updateWorldInfoList, reloadWorldInfoEditor }) });
    vi.stubGlobal('rebindChatWorldbook', rebindChatWorldbook);
    const createOrReplaceWorldbook = vi.fn();
    vi.stubGlobal('createOrReplaceWorldbook', createOrReplaceWorldbook);

    await createTavernServices().environment.applyWorld(rawSnapshot(data));

    expect(saveWorldInfo).toHaveBeenCalledWith('Book', data, true);
    expect(saveWorldInfo.mock.calls[0]?.[1]).not.toBe(data);
    expect(rebindChatWorldbook).toHaveBeenCalledWith('current', 'Book');
    expect(reloadWorldInfoEditor).toHaveBeenCalledWith('Book');
    expect(calls).toEqual(['save', 'list', 'editor', 'bind']);
    expect(createOrReplaceWorldbook).not.toHaveBeenCalled();
  });

  it('validates every raw book before overwriting any book', async () => {
    const saveWorldInfo = vi.fn();
    vi.stubGlobal('SillyTavern', { getContext: () => ({ saveWorldInfo }) });
    const snapshot = rawSnapshot({ entries: {} });
    snapshot.books.Broken = undefined;

    await expect(createTavernServices().environment.applyWorld(snapshot)).rejects.toThrow('Broken');
    expect(saveWorldInfo).not.toHaveBeenCalled();
  });

  it('rejects raw restore on an unsupported host without passing raw JSON to the Helper', async () => {
    const createOrReplaceWorldbook = vi.fn();
    vi.stubGlobal('createOrReplaceWorldbook', createOrReplaceWorldbook);

    await expect(createTavernServices().environment.applyWorld(rawSnapshot({ entries: {} }))).rejects.toThrow('Raw Worldbook restore API is unavailable');
    expect(createOrReplaceWorldbook).not.toHaveBeenCalled();
  });

  it('backs up and restores a worldbook through Drive without losing missing keys, regex strings or extensions', async () => {
    const original = { entries: { 1: { uid: 1, key: ['/dragon/i'], content: 'cloud' } }, extensions: { custom: true } };
    let current = structuredClone(original);
    vi.stubGlobal('getChatWorldbookName', () => 'Book');
    vi.stubGlobal('getVariables', () => ({}));
    vi.stubGlobal('SillyTavern', { getContext: () => ({
      loadWorldInfo: async () => current,
      saveWorldInfo: async (_name: string, data: typeof original) => { current = data; }
    }) });
    const drive = new DriveService(new MemoryDriveClient());
    const adapter = createTavernServices().environment;
    const backup = new EnvironmentBackupService(adapter, drive);
    const restore = new EnvironmentRestoreService(adapter, drive);
    const meta = { role_key: 'Role', chat_id: 'Chat', device: 'Device', pushed_from_here: false };

    expect(await backup.backupItems(['world'], { meta })).toEqual([
      { kind: 'world', status: 'done', filename: expect.any(String) }
    ]);
    const versions = await backup.listItemVersions('world', meta);
    const downloaded = await backup.downloadItem('world', versions[0]!.fileId);
    expect(downloaded.books.Book).toEqual(original);
    current.entries[1].content = 'local changes';

    const result = await restore.restoreLatest(['world'], { meta });

    expect(result.items).toEqual([{ kind: 'world', status: 'done', filename: expect.any(String) }]);
    expect(current).toEqual(original);
    const restorePoints = await drive.listVersions([...result.restorePointPath, 'world']);
    const restorePoint = await backup.downloadItem('world', restorePoints[0]!.fileId);
    expect(restorePoint.books.Book).toEqual({ ...original, entries: { 1: { ...original.entries[1], content: 'local changes' } } });
  });

  it('detects native worldbook support and reports missing raw restore support', () => {
    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo: vi.fn(), saveWorldInfo: vi.fn() }) });
    expect(createTavernServices().capabilities.environment.world).toBe(true);
    expect(createTavernServices().diagnostics.environmentRestoreMissing('world')).toEqual([]);

    vi.stubGlobal('SillyTavern', { getContext: () => ({ loadWorldInfo: vi.fn() }) });
    expect(createTavernServices().diagnostics.environmentRestoreMissing('world')).toEqual(['saveWorldInfo']);
  });
});

function rawSnapshot(data: unknown): WorldSnapshot {
  return {
    kind: 'world', exportedAt: '2026-09-14T00:00:00.000Z', format: 'sillytavern-worldinfo-v1',
    bindings: { ...emptyBindings, chat: 'Book' }, books: { Book: data }
  };
}

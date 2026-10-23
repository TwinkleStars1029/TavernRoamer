import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentExportPort } from '../src/environment/EnvironmentPort';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { EnvironmentBackupService, environmentItemPath } from '../src/environment/EnvironmentBackupService';
import {
  ENVIRONMENT_ITEM_KINDS,
  type EnvironmentItemKind,
  type EnvironmentProgressEvent,
} from '../src/environment/types';

describe('EnvironmentBackupService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('backs up all environment items into per-kind folders', async () => {
    stubScriptVariables({ chatRetention: { mode: 'keep_latest_n', latestN: 10 } });
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new EnvironmentBackupService(adapter, new DriveService(drive));

    const results = await service.backupAll();

    expect(results).toHaveLength(ENVIRONMENT_ITEM_KINDS.length);
    for (const kind of ENVIRONMENT_ITEM_KINDS) {
      const versions = await service.listItemVersions(kind);
      expect(versions).toHaveLength(1);
    }
  });

  it('keeps only the latest N versions per item kind', async () => {
    stubScriptVariables({ chatRetention: { mode: 'keep_latest_n', latestN: 2 } });
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new EnvironmentBackupService(adapter, new DriveService(drive));

    for (let index = 0; index < 3; index += 1) {
      await service.backupItems(['preset']);
    }

    const versions = await service.listItemVersions('preset');
    expect(versions).toHaveLength(2);
  });

  it('downloads a backed-up item with the expected kind', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const service = new EnvironmentBackupService(adapter, driveService);

    await service.backupItems(['world']);
    const versions = await service.listItemVersions('world');
    const snapshot = await service.downloadItem('world', versions[0]!.fileId);

    expect(snapshot.kind).toBe('world');
    expect(snapshot.bindings.chat).toBe('ChatBook');
  });

  it('emits ordered export/upload progress events and marks each item done', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new EnvironmentBackupService(adapter, new DriveService(drive));

    const events: EnvironmentProgressEvent[] = [];
    const results = await service.backupItems(['character', 'world'], {
      onProgress: event => events.push(event)
    });

    expect(results.map(result => ({ kind: result.kind, status: result.status }))).toEqual([
      { kind: 'character', status: 'done' },
      { kind: 'world', status: 'done' }
    ]);
    expect(results.every(result => typeof result.filename === 'string')).toBe(true);

    expect(events.map(event => `${event.kind}:${event.step}:${event.state}`)).toEqual([
      'character:export:start',
      'character:export:done',
      'character:upload:start',
      'character:upload:done',
      'world:export:start',
      'world:export:done',
      'world:upload:start',
      'world:upload:done'
    ]);
    // upload done carries the filename
    const uploadDone = events.filter(event => event.step === 'upload' && event.state === 'done');
    expect(uploadDone.every(event => typeof event.filename === 'string')).toBe(true);
  });

  it('records a failed item and continues backing up the rest', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    adapter.exportPreset = async () => {
      throw new Error('preset export failed');
    };
    const drive = new MemoryDriveClient();
    const service = new EnvironmentBackupService(adapter, new DriveService(drive));

    const events: EnvironmentProgressEvent[] = [];
    const results = await service.backupItems(['preset', 'regex'], {
      onProgress: event => events.push(event)
    });

    expect(results).toEqual([
      { kind: 'preset', status: 'error', error: 'preset export failed' },
      { kind: 'regex', status: 'done', filename: expect.any(String) }
    ]);

    // preset failed during export → only export start + error, no upload events
    expect(events.filter(event => event.kind === 'preset').map(event => `${event.step}:${event.state}`)).toEqual([
      'export:start',
      'export:error'
    ]);
    expect(events.find(event => event.kind === 'preset' && event.state === 'error')?.error).toBe('preset export failed');

    // regex still completes normally
    expect(events.filter(event => event.kind === 'regex').map(event => `${event.step}:${event.state}`)).toEqual([
      'export:start',
      'export:done',
      'upload:start',
      'upload:done'
    ]);
    const regexVersions = await service.listItemVersions('regex');
    expect(regexVersions).toHaveLength(1);
    // failed item never uploaded
    const presetVersions = await service.listItemVersions('preset');
    expect(presetVersions).toHaveLength(0);
  });

  it('uses one shared timestamped filename across the whole batch', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const service = new EnvironmentBackupService(adapter, new DriveService(drive));

    const results = await service.backupItems(['character', 'world', 'persona', 'preset', 'regex']);
    const filenames = new Set(results.map(result => result.filename));
    expect(filenames.size).toBe(1);
  });

  it('builds environment item paths under role_key and chat_id', () => {
    expect(environmentItemPath({ role_key: 'Role', chat_id: '2026-06-28@15h24m22s470ms' }, 'regex')).toEqual([
      'SillyTavernSync',
      'Role',
      '2026-06-28@15h24m22s470ms',
      'regex'
    ]);
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

function fakeAdapter(): EnvironmentExportPort {
  const variables: Record<string, unknown> = {};
  const snapshots = new Map<EnvironmentItemKind, unknown>([
    ['character', { title: 'character-data' }],
    ['world', { entries: { 1: { uid: 1 } } }],
    ['persona', { title: 'persona-data' }],
    ['preset', { title: 'preset-data' }],
    ['regex', [{ id: 1, scriptName: 'global-regex' }]]
  ]);

  return {
    getChatVariables() {
      return variables;
    },
    writeChatVariables(value: Record<string, unknown>) {
      Object.assign(variables, value);
    },
    getCurrentCharacterName() {
      return 'Role';
    },
    getCurrentChatFileName() {
      return 'Role - 2026-06-28@15h24m22s470ms.json';
    },
    async exportCharacter() {
      return {
        kind: 'character',
        exportedAt: new Date().toISOString(),
        characterName: 'Role',
        data: snapshots.get('character')
      };
    },
    async exportWorld() {
      return {
        kind: 'world',
        exportedAt: new Date().toISOString(),
        format: 'sillytavern-worldinfo-v1',
        bindings: { chat: 'ChatBook', char_primary: 'CharBook', char_additional: ['ExtraBook'], global_enabled: ['GlobalBook'] },
        books: {
          ChatBook: snapshots.get('world'),
          CharBook: { entries: {} },
          ExtraBook: { entries: {} },
          GlobalBook: { entries: {} }
        }
      };
    },
    async exportPersona() {
      return {
        kind: 'persona',
        exportedAt: new Date().toISOString(),
        name: 'Role Persona',
        data: snapshots.get('persona')
      };
    },
    async exportPreset() {
      return {
        kind: 'preset',
        exportedAt: new Date().toISOString(),
        name: 'Preset A',
        data: snapshots.get('preset')
      };
    },
    async exportRegex() {
      return {
        kind: 'regex',
        exportedAt: new Date().toISOString(),
        scope: 'global',
        items: snapshots.get('regex') as unknown[]
      };
    }
  };
}

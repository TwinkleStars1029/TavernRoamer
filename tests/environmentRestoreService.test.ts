import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TavernChatAdapter } from '../src/chat/ChatSyncService';
import type { DriveClient } from '../src/drive/DriveClient';
import { DriveService } from '../src/drive/DriveService';
import { MemoryDriveClient } from '../src/drive/MemoryDriveClient';
import { EnvironmentBackupService } from '../src/environment/EnvironmentBackupService';
import { EnvironmentRestoreService } from '../src/environment/EnvironmentRestoreService';
import type { EnvironmentItemKind, EnvironmentProgressEvent } from '../src/environment/types';

// DriveService that fails uploadJson for a given kind — used to inject a pre-restore backup failure.
class PreRestoreFailingDriveService extends DriveService {
  constructor(
    client: DriveClient,
    private failKind: EnvironmentItemKind
  ) {
    super(client);
  }

  override async uploadJson(folderId: string, filename: string, content: unknown) {
    if (content && typeof content === 'object' && (content as { kind?: string }).kind === this.failKind) {
      throw new Error(`pre-restore upload failed for ${this.failKind}`);
    }
    return super.uploadJson(folderId, filename, content);
  }
}

describe('EnvironmentRestoreService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restores latest selected items in environment order and writes pre-restore backups', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T12:34:56.000Z'));
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const backupService = new EnvironmentBackupService(adapter, driveService);
    const restoreService = new EnvironmentRestoreService(adapter, driveService);

    await backupService.backupItems(['preset', 'character', 'regex']);
    adapter.applied.length = 0;

    const result = await restoreService.restoreLatest(['regex', 'character', 'preset']);

    expect(adapter.applied).toEqual(['character', 'preset', 'regex']);
    expect(result.items.filter(item => item.status === 'done').map(item => item.kind)).toEqual([
      'character',
      'preset',
      'regex'
    ]);
    expect(result.items.filter(item => item.status === 'skipped')).toEqual([]);

    const preRestoreCharacterVersions = await driveService.listVersions([
      'SillyTavernSync',
      'Role',
      '2026-06-28@15h24m22s470ms',
      '_pre_restore',
      '2026-07-06T12-34-56Z',
      'character'
    ]);
    expect(preRestoreCharacterVersions).toHaveLength(1);
  });

  it('skips items without remote backups and restores what exists', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const driveService = new DriveService(drive);
    const backupService = new EnvironmentBackupService(adapter, driveService);
    const restoreService = new EnvironmentRestoreService(adapter, driveService);

    await backupService.backupItems(['world']);
    adapter.applied.length = 0;

    const result = await restoreService.restoreLatest(['world', 'persona']);

    expect(adapter.applied).toEqual(['world']);
    expect(result.items.filter(item => item.status === 'done').map(item => item.kind)).toEqual(['world']);
    expect(result.items.filter(item => item.status === 'skipped').map(item => item.kind)).toEqual(['persona']);
  });

  it('aborts an item whose pre-restore backup fails and continues with the rest', async () => {
    stubScriptVariables();
    const adapter = fakeAdapter();
    const drive = new MemoryDriveClient();
    const backupService = new EnvironmentBackupService(adapter, new DriveService(drive));

    await backupService.backupItems(['character', 'preset']);
    adapter.applied.length = 0;

    const restoreService = new EnvironmentRestoreService(adapter, new PreRestoreFailingDriveService(drive, 'character'));
    const events: EnvironmentProgressEvent[] = [];
    const result = await restoreService.restoreLatest(['character', 'preset'], {
      onProgress: event => events.push(event)
    });

    const statusByKind = Object.fromEntries(result.items.map(item => [item.kind, item.status]));
    expect(statusByKind).toEqual({ character: 'aborted', preset: 'done' });

    // aborted item is never applied; other item still applied
    expect(adapter.applied).toEqual(['preset']);

    // character stops at backup_current:error — no download/apply events
    const characterEvents = events.filter(event => event.kind === 'character').map(event => `${event.step}:${event.state}`);
    expect(characterEvents).toEqual(['backup_current:start', 'backup_current:error']);

    // preset runs the full backup_current → download → apply sequence
    const presetEvents = events.filter(event => event.kind === 'preset').map(event => `${event.step}:${event.state}`);
    expect(presetEvents).toEqual([
      'backup_current:start',
      'backup_current:done',
      'download:start',
      'download:done',
      'apply:start',
      'apply:done'
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

function fakeAdapter(): TavernChatAdapter & {
  applied: EnvironmentItemKind[];
} {
  const variables: Record<string, unknown> = {};

  return {
    applied: [],
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
    getMessages() {
      return [];
    },
    getChatWorldbook() {
      return 'ChatBook';
    },
    async exportRawChat() {
      return { content: '', messageCount: 0 };
    },
    async exportCharacter() {
      return {
        kind: 'character',
        exportedAt: new Date().toISOString(),
        characterName: 'Role',
        data: { name: 'Role Character' }
      };
    },
    async exportWorld() {
      return {
        kind: 'world',
        exportedAt: new Date().toISOString(),
        bindings: { chat: 'ChatBook', char_primary: 'CharBook', char_additional: [], global_enabled: [] },
        books: { ChatBook: { entries: [] } }
      };
    },
    async exportPersona() {
      return {
        kind: 'persona',
        exportedAt: new Date().toISOString(),
        name: 'Role Persona',
        data: { name: 'Role Persona' }
      };
    },
    async exportPreset() {
      return {
        kind: 'preset',
        exportedAt: new Date().toISOString(),
        name: 'Preset A',
        data: { temp: 1 }
      };
    },
    async exportRegex() {
      return {
        kind: 'regex',
        exportedAt: new Date().toISOString(),
        scope: 'global',
        items: [{ scriptName: 'global-regex' }]
      };
    },
    async applyCharacter() {
      this.applied.push('character');
    },
    async applyWorld() {
      this.applied.push('world');
    },
    async applyPersona() {
      this.applied.push('persona');
    },
    async applyPreset() {
      this.applied.push('preset');
    },
    async applyRegex() {
      this.applied.push('regex');
    },
    async replaceRawChat() {
      return undefined;
    },
    async replaceChat() {
      return undefined;
    }
  };
}

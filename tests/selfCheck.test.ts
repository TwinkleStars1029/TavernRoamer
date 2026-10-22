import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SelfCheckModule from '../src/selfCheck';
import type { DriveService } from '../src/drive/DriveService';
import { parseVersionFilename } from '../src/drive/version';
import { createTavernServices } from '../src/tavern';

let selfCheck: typeof SelfCheckModule;

beforeEach(async () => {
  vi.resetModules();
  selfCheck = await import('../src/selfCheck');
});

afterEach(() => {
  for (const key of [
    'getCharacter',
    'getCurrentCharacterName',
    'insertOrAssignVariables',
    'createOrReplaceCharacter',
    'SillyTavern'
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function registerCase(
  id: string,
  run: () => Promise<{ status: 'pass'; message: string }>,
  options: { mode?: 'quick' | 'advanced'; timeoutMs?: number } = {}
) {
  selfCheck.registerSelfCheck({
    id,
    label: id,
    category: options.mode === 'advanced' ? 'advanced' : 'settings',
    safety: options.mode === 'advanced' ? 'destructive' : 'read_only',
    mode: options.mode ?? 'quick',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    run
  });
}

describe('self check runner', () => {
  it('collects pass and fail results without aborting the run', async () => {
    registerCase('unit.pass', async () => ({ status: 'pass', message: 'ok' }));
    selfCheck.registerSelfCheck({
      id: 'unit.fail',
      label: 'unit.fail',
      category: 'settings',
      safety: 'read_only',
      mode: 'quick',
      async run() {
        throw new Error('boom');
      }
    });

    const results = await selfCheck.runSelfChecks();

    expect(results.find(result => result.id === 'unit.pass')).toMatchObject({
      status: 'pass',
      category: 'settings',
      safety: 'read_only',
      mode: 'quick'
    });
    expect(results.find(result => result.id === 'unit.fail')).toMatchObject({ status: 'fail', message: 'boom' });
  });

  it('times out one case and still completes later cases with progress events', async () => {
    registerCase('unit.timeout', () => new Promise(() => undefined), { timeoutMs: 5 });
    registerCase('unit.after-timeout', async () => ({ status: 'pass', message: 'continued' }));
    const events: SelfCheckModule.SelfCheckProgress[] = [];

    const results = await selfCheck.runSelfChecks({ onProgress: event => events.push(event) });

    expect(results.find(result => result.id === 'unit.timeout')).toMatchObject({ status: 'fail' });
    expect(results.find(result => result.id === 'unit.after-timeout')).toMatchObject({ status: 'pass' });
    expect(events.map(event => `${event.phase}:${event.currentId}`)).toEqual([
      'start:unit.timeout',
      'complete:unit.timeout',
      'start:unit.after-timeout',
      'complete:unit.after-timeout'
    ]);
  });

  it('returns the active run instead of starting a duplicate run', async () => {
    let release: (() => void) | undefined;
    let runs = 0;
    registerCase('unit.lock', async () => {
      runs += 1;
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return { status: 'pass', message: 'done' };
    });

    const first = selfCheck.runSelfChecks();
    const second = selfCheck.runSelfChecks();
    expect(second).toBe(first);
    release?.();
    await first;
    expect(runs).toBe(1);
  });
});

describe('self check catalog', () => {
  it('keeps destructive checks out of the quick catalog', () => {
    selfCheck.registerPhase0SelfChecks();
    const tavern = createTavernServices();
    selfCheck.registerApiSpikeSelfChecks(tavern);
    selfCheck.registerChatSelfChecks(tavern);
    selfCheck.registerPullSelfChecks(tavern);

    const quick = selfCheck.getSelfCheckCases('quick');
    const advanced = selfCheck.getSelfCheckCases('advanced');

    expect(quick.every(testCase => testCase.safety !== 'destructive')).toBe(true);
    expect(quick.map(testCase => testCase.id)).not.toEqual(
      expect.arrayContaining(['drive.mock.memory', 'api.chat.importRawChat', 'ui.panel.mounted', 'chat.pack.roundtrip'])
    );
    expect(advanced.map(testCase => testCase.id)).toEqual(
      expect.arrayContaining(['advanced.character.roundtrip', 'advanced.chat.replace.roundtrip'])
    );
  });

  it('registers cloud chat support as a read-only quick check', () => {
    selfCheck.registerPullSelfChecks(createTavernServices());
    expect(selfCheck.getSelfCheckCases('quick').find(testCase => testCase.id === 'api.chat.pull.support')).toMatchObject({
      safety: 'read_only',
      category: 'cloud_chat'
    });
  });

  it('treats a missing current character as blocked instead of failed', async () => {
    (globalThis as Record<string, unknown>).getCharacter = vi.fn(async () => {
      throw new Error("角色卡 'current' 不存在");
    });
    selfCheck.registerApiSpikeSelfChecks(createTavernServices());
    const character = selfCheck
      .getSelfCheckCases('quick')
      .find(testCase => testCase.id === 'environment.export.character');

    await expect(character!.run()).resolves.toMatchObject({ status: 'blocked', action: 'select_chat' });
  });

  it('treats a missing selected-character avatar as blocked instead of failed', async () => {
    const context = {
      characters: [{ name: '角色 A' }],
      openCharacterChat: vi.fn(),
      selectCharacterById: vi.fn()
    };
    Object.assign(globalThis, {
      getCurrentCharacterName: () => '角色 A',
      insertOrAssignVariables: vi.fn(),
      createOrReplaceCharacter: vi.fn(),
      SillyTavern: { getContext: () => context }
    });
    selfCheck.registerPullSelfChecks(createTavernServices());
    const pull = selfCheck
      .getSelfCheckCases('quick')
      .find(testCase => testCase.id === 'api.chat.pull.support');

    await expect(pull!.run()).resolves.toMatchObject({ status: 'blocked', action: 'select_chat' });
  });
});

describe('Drive smoke cleanup', () => {
  it('uses a filename accepted by the real version listing path', async () => {
    let uploadedFilename = '';
    let uploadedPayload: { ok: boolean; marker: string } | null = null;
    const deleteFile = vi.fn(async () => undefined);
    const drive = {
      ensureFolderPath: vi.fn(async () => 'folder-1'),
      uploadJson: vi.fn(async (_folderId: string, filename: string, payload: { ok: boolean; marker: string }) => {
        uploadedFilename = filename;
        uploadedPayload = payload;
        return { id: 'file-1' };
      }),
      listVersions: vi.fn(async () =>
        parseVersionFilename(uploadedFilename) ? [{ fileId: 'file-1' }] : []
      ),
      downloadJson: vi.fn(async () => uploadedPayload),
      deleteFile
    } as unknown as DriveService;
    selfCheck.registerDriveSelfChecks(drive, () => ({ connected: true, email: 'user@example.com', error: null }));
    const smoke = selfCheck.getSelfCheckCases('quick').find(testCase => testCase.id === 'drive.real.smoke');

    await expect(smoke!.run()).resolves.toMatchObject({ status: 'pass' });
    expect(parseVersionFilename(uploadedFilename)).not.toBeNull();
    expect(deleteFile).toHaveBeenNthCalledWith(1, 'file-1');
    expect(deleteFile).toHaveBeenNthCalledWith(2, 'folder-1');
  });

  it('attempts to delete both the uploaded file and temporary folder after failure', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const drive = {
      ensureFolderPath: vi.fn(async () => 'folder-1'),
      uploadJson: vi.fn(async () => ({ id: 'file-1' })),
      listVersions: vi.fn(async () => [{ fileId: 'file-1' }]),
      downloadJson: vi.fn(async () => {
        throw new Error('download failed');
      }),
      deleteFile
    } as unknown as DriveService;
    selfCheck.registerDriveSelfChecks(drive, () => ({ connected: true, email: 'user@example.com', error: null }));
    const smoke = selfCheck.getSelfCheckCases('quick').find(testCase => testCase.id === 'drive.real.smoke');

    const result = await smoke!.run();

    expect(result.status).toBe('fail');
    expect(deleteFile).toHaveBeenNthCalledWith(1, 'file-1');
    expect(deleteFile).toHaveBeenNthCalledWith(2, 'folder-1');
  });
});

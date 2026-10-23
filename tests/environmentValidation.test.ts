import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnvironmentSnapshot, SnapshotValidationError } from '../src/environment/validation';
import { createTavernServices } from '../src/tavern';
import type { CharacterSnapshot } from '../src/environment/types';

describe('environment snapshot validation', () => {
  it('normalizes a known legacy character snapshot to schema version 1 and preserves extensions', () => {
    const snapshot = parseEnvironmentSnapshot('character', {
      kind: 'character',
      exportedAt: '2026-09-23T01:02:03.000Z',
      characterName: 'Alice',
      data: { name: 'Alice', extensions: { custom: { enabled: true } } },
      vendorExtension: { keep: true }
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect((snapshot as CharacterSnapshot & { vendorExtension: unknown }).vendorExtension).toEqual({ keep: true });
    expect((snapshot.data as Record<string, unknown>).extensions).toEqual({ custom: { enabled: true } });
  });

  it('rejects missing regex items instead of converting them to an empty list', () => {
    expect(() => parseEnvironmentSnapshot('regex', {
      schemaVersion: 1,
      kind: 'regex',
      exportedAt: '2026-09-23T01:02:03.000Z',
      scope: 'global'
    })).toThrowError(SnapshotValidationError);
  });

  it('rejects an unknown schema version and an explicitly unknown format', () => {
    expect(() => parseEnvironmentSnapshot('persona', {
      schemaVersion: 2,
      kind: 'persona',
      exportedAt: '2026-09-23T01:02:03.000Z',
      name: 'P',
      data: { name: 'P' }
    })).toThrow('不支援的環境備份版本');

    expect(() => parseEnvironmentSnapshot('preset', {
      schemaVersion: 1,
      kind: 'preset',
      exportedAt: '2026-09-23T01:02:03.000Z',
      name: 'P',
      format: 'future-v9',
      data: {}
    })).toThrow('不支援的備份格式');
  });

  it('validates all bound worldbooks before returning a restore value', () => {
    expect(() => parseEnvironmentSnapshot('world', {
      schemaVersion: 1,
      kind: 'world',
      exportedAt: '2026-09-23T01:02:03.000Z',
      format: 'sillytavern-worldinfo-v1',
      bindings: { chat: 'Missing', char_primary: null, char_additional: [], global_enabled: [] },
      books: { Existing: { entries: {} } }
    })).toThrow('Missing');
  });
});

describe('regex restore merge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('overwrites matching rules and preserves local-only rules', async () => {
    const replace = vi.fn();
    vi.stubGlobal('getTavernRegexes', async () => [
      { id: 'same', scriptName: 'Same', findRegex: 'old', replaceString: 'old' },
      { id: 'local', scriptName: 'Local', findRegex: 'x', replaceString: 'y' }
    ]);
    vi.stubGlobal('replaceTavernRegexes', replace);

    await createTavernServices().environment.applyRegex({
      schemaVersion: 1,
      kind: 'regex',
      exportedAt: '2026-09-23T01:02:03.000Z',
      scope: 'global',
      items: [
        { id: 'new-id', scriptName: 'Same', findRegex: 'new', replaceString: 'new' },
        { id: 'cloud', scriptName: 'Cloud', findRegex: 'a', replaceString: 'b' }
      ]
    });

    expect(replace).toHaveBeenCalledWith([
      { id: 'new-id', scriptName: 'Same', findRegex: 'new', replaceString: 'new' },
      { id: 'local', scriptName: 'Local', findRegex: 'x', replaceString: 'y' },
      { id: 'cloud', scriptName: 'Cloud', findRegex: 'a', replaceString: 'b' }
    ], { type: 'global' });
  });

  it('does not mutate regexes when any incoming member is invalid', async () => {
    const replace = vi.fn();
    vi.stubGlobal('getTavernRegexes', async () => []);
    vi.stubGlobal('replaceTavernRegexes', replace);

    await expect(createTavernServices().environment.applyRegex({
      kind: 'regex',
      exportedAt: '2026-09-23T01:02:03.000Z',
      scope: 'global',
      items: [{}]
    })).rejects.toThrow('缺少 id');
    expect(replace).not.toHaveBeenCalled();
  });
});

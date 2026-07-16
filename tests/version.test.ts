import { describe, expect, it } from 'vitest';
import {
  buildVersionFilename,
  createUtcTimestamp,
  formatLastSyncedLabel,
  parseVersionFilename,
  parseUtcTimestamp
} from '../src/drive/version';

describe('version timestamp helpers', () => {
  it('creates UTC timestamps that sort lexicographically', () => {
    const first = createUtcTimestamp(new Date('2026-06-25T14:45:00+08:00'));
    const second = createUtcTimestamp(new Date('2026-06-25T08:00:00Z'));

    expect(first).toBe('2026-06-25T06-45-00Z');
    expect(second).toBe('2026-06-25T08-00-00Z');
    expect([second, first].sort()).toEqual([first, second]);
  });

  it('parses version filename device and timestamp', () => {
    const filename = buildVersionFilename('A電腦', new Date('2026-06-25T14:45:00Z'));
    const parsed = parseVersionFilename(filename);

    expect(filename).toBe('2026-06-25T14-45-00Z__A電腦.json');
    expect(parsed?.device).toBe('A電腦');
    expect(parsed?.uploadedAt.toISOString()).toBe('2026-06-25T14:45:00.000Z');
  });

  it('rejects malformed timestamps', () => {
    expect(parseUtcTimestamp('2026-06-25T14:45:00+08:00')).toBeNull();
    expect(parseVersionFilename('not-a-version.json')).toBeNull();
  });
});

describe('formatLastSyncedLabel', () => {
  it('converts a UTC filename timestamp into the target timezone', () => {
    // 14:45 UTC + 8h → 22:45 台北
    const label = formatLastSyncedLabel('2026-06-25T14-45-00Z__A電腦.json', {
      locale: 'en-US',
      timeZone: 'Asia/Taipei'
    });
    expect(label).toContain('22:45:00');
    expect(label).toContain('2026');
  });

  it('renders UTC directly when timezone is UTC and supports jsonl', () => {
    expect(
      formatLastSyncedLabel('2026-06-25T14-45-00Z__A電腦.jsonl', { locale: 'en-US', timeZone: 'UTC' })
    ).toContain('14:45:00');
  });

  it('falls back for missing or invalid filenames', () => {
    expect(formatLastSyncedLabel(null)).toBe('—');
    expect(formatLastSyncedLabel(undefined)).toBe('—');
    expect(formatLastSyncedLabel('')).toBe('—');
    expect(formatLastSyncedLabel('not-a-version.json')).toBe('—');
    expect(formatLastSyncedLabel('2026-13-40T99-99-99Z__X.json')).toBe('—');
  });

  it('honors a custom fallback string', () => {
    expect(formatLastSyncedLabel('garbage', { fallback: '尚未同步' })).toBe('尚未同步');
  });
});

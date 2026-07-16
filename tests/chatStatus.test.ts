import { describe, expect, it } from 'vitest';
import { computeSyncStatus } from '../src/chat/status';

describe('computeSyncStatus', () => {
  it.each([
    [{ connected: false, meta: null, remoteLatestFilename: null, localMessageCount: 0 }, 'not_connected'],
    [{ connected: true, meta: null, remoteLatestFilename: null, localMessageCount: 1 }, 'local_dirty'],
    [
      {
        connected: true,
        meta: { chat_id: 'chat_1', role_key: '路特', last_synced_version: '2026-01-01T00-00-00Z__A.json', last_synced_message_count: 2 },
        remoteLatestFilename: '2026-01-01T00-00-00Z__A.json',
        localMessageCount: 2
      },
      'synced'
    ],
    [
      {
        connected: true,
        meta: { chat_id: 'chat_1', role_key: '路特', last_synced_version: '2026-01-01T00-00-00Z__A.json', last_synced_message_count: 2 },
        remoteLatestFilename: '2026-01-01T00-01-00Z__B.json',
        localMessageCount: 2
      },
      'newer_remote'
    ],
    [
      {
        connected: true,
        meta: { chat_id: 'chat_1', role_key: '路特', last_synced_version: '2026-01-01T00-00-00Z__A.json', last_synced_message_count: 2 },
        remoteLatestFilename: '2026-01-01T00-00-00Z__A.json',
        localMessageCount: 3
      },
      'local_dirty'
    ]
  ] as const)('returns %s', (input, expected) => {
    expect(computeSyncStatus(input)).toBe(expected);
  });
});

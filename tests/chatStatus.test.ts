import { describe, expect, it } from 'vitest';
import { computeSyncStatus, deriveSyncFacts } from '../src/chat/status';
import type { ChatSyncMeta } from '../src/types';

const baselineFilename = '2026-01-01T00-00-00Z__A.jsonl';
const newerFilename = '2026-01-01T00-01-00Z__B.jsonl';
const olderFilename = '2025-12-31T23-59-00Z__B.jsonl';
const cleanMeta: ChatSyncMeta = {
  chat_id: 'chat_1',
  role_key: '路特',
  last_synced_version: baselineFilename,
  last_synced_message_count: 2,
  last_synced_content_hash: 'baseline-hash',
  last_synced_hash_version: 1
};

describe('computeSyncStatus', () => {
  it.each([
    [{ connected: false, meta: null, remoteLatestFilename: null, localMessageCount: 0 }, 'not_connected'],
    [{ connected: true, meta: null, remoteLatestFilename: null, localMessageCount: 1 }, 'untracked'],
    [{ connected: true, meta: null, remoteLatestFilename: baselineFilename, localMessageCount: 1 }, 'remote_available'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: baselineFilename, localMessageCount: 2, localContentHash: 'baseline-hash' }, 'synced'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: baselineFilename, localMessageCount: 2, localContentHash: 'edited' }, 'local_dirty'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: newerFilename, localMessageCount: 2, localContentHash: 'baseline-hash' }, 'newer_remote'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: newerFilename, localMessageCount: 2, localContentHash: 'edited' }, 'conflict'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: null, localMessageCount: 2, localContentHash: 'baseline-hash' }, 'remote_missing'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: olderFilename, localMessageCount: 2, localContentHash: 'baseline-hash' }, 'remote_mismatch'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: null, localMessageCount: 2, localContentHash: 'baseline-hash', remoteCheckFailed: true }, 'check_failed'],
    [{ connected: true, meta: cleanMeta, remoteLatestFilename: baselineFilename, localMessageCount: 2, localCheckFailed: true }, 'unknown']
  ] as const)('derives an honest status for %#', (input, expected) => {
    expect(computeSyncStatus(input)).toBe(expected);
  });

  it('keeps pending uploads as a separate fact instead of hiding a conflict', () => {
    expect(deriveSyncFacts({
      connected: true,
      meta: cleanMeta,
      remoteLatestFilename: newerFilename,
      localMessageCount: 2,
      localContentHash: 'edited',
      pendingUploads: 2
    })).toMatchObject({ local: 'dirty', remote: 'ahead', pendingUploads: 2 });
  });

  it('uses confirmed baseline presence instead of trusting device filename clocks', () => {
    expect(computeSyncStatus({
      connected: true,
      meta: cleanMeta,
      remoteLatestFilename: olderFilename,
      remoteBaselineFound: true,
      localMessageCount: 2,
      localContentHash: 'baseline-hash'
    })).toBe('newer_remote');
  });

  it('treats message deletion as dirty for legacy metadata without a hash', () => {
    expect(computeSyncStatus({
      connected: true,
      meta: { chat_id: 'chat_1', role_key: '路特', last_synced_version: baselineFilename, last_synced_message_count: 3 },
      remoteLatestFilename: baselineFilename,
      localMessageCount: 2
    })).toBe('local_dirty');
  });
});

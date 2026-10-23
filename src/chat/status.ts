import type { ChatSyncMeta, SyncStatus } from '../types';
import { CHAT_CONTENT_HASH_VERSION } from './snapshot';

export type SyncFacts = Readonly<{
  connection: 'disconnected' | 'ready' | 'error';
  local: 'untracked' | 'clean' | 'dirty' | 'unknown';
  remote: 'unchecked' | 'missing' | 'same' | 'ahead' | 'behind' | 'exists_untracked';
  pendingUploads: number;
}>;

export function computeSyncStatus(input: {
  connected: boolean;
  meta: ChatSyncMeta | null;
  remoteLatestFilename: string | null;
  localMessageCount: number;
  localContentHash?: string | null;
  remoteBaselineFound?: boolean;
  remoteCheckFailed?: boolean;
  localCheckFailed?: boolean;
  pendingUploads?: number;
}): SyncStatus {
  return deriveSyncStatus(deriveSyncFacts(input));
}

export function deriveSyncFacts(input: {
  connected: boolean;
  meta: ChatSyncMeta | null;
  remoteLatestFilename: string | null;
  localMessageCount: number;
  localContentHash?: string | null;
  remoteBaselineFound?: boolean;
  remoteCheckFailed?: boolean;
  localCheckFailed?: boolean;
  pendingUploads?: number;
}): SyncFacts {
  const baseline = input.meta?.last_synced_version ?? null;
  const connection: SyncFacts['connection'] = !input.connected
    ? 'disconnected'
    : input.remoteCheckFailed
      ? 'error'
      : 'ready';

  let local: SyncFacts['local'];
  if (!baseline) {
    local = 'untracked';
  } else if (input.localCheckFailed) {
    local = 'unknown';
  } else if (input.meta?.last_synced_content_hash) {
    local = input.meta.last_synced_hash_version !== CHAT_CONTENT_HASH_VERSION || !input.localContentHash
      ? 'unknown'
      : input.localContentHash === input.meta.last_synced_content_hash
        ? 'clean'
        : 'dirty';
  } else if (typeof input.meta?.last_synced_message_count === 'number') {
    local = input.meta.last_synced_message_count === input.localMessageCount ? 'unknown' : 'dirty';
  } else {
    local = 'unknown';
  }

  let remote: SyncFacts['remote'];
  if (!input.connected || input.remoteCheckFailed) {
    remote = 'unchecked';
  } else if (!input.remoteLatestFilename) {
    remote = 'missing';
  } else if (!baseline) {
    remote = 'exists_untracked';
  } else if (input.remoteLatestFilename === baseline) {
    remote = 'same';
  } else if (input.remoteBaselineFound === true) {
    remote = 'ahead';
  } else if (input.remoteBaselineFound === false) {
    remote = 'behind';
  } else {
    const order = input.remoteLatestFilename.localeCompare(baseline);
    remote = order > 0 ? 'ahead' : 'behind';
  }

  return {
    connection,
    local,
    remote,
    pendingUploads: Math.max(0, Math.floor(input.pendingUploads ?? 0))
  };
}

export function deriveSyncStatus(facts: SyncFacts): SyncStatus {
  if (facts.connection === 'disconnected') return 'not_connected';
  if (facts.connection === 'error') return 'check_failed';
  if (facts.local === 'untracked') return facts.remote === 'exists_untracked' ? 'remote_available' : 'untracked';
  if (facts.remote === 'missing') return 'remote_missing';
  if (facts.remote === 'behind') return 'remote_mismatch';
  if (facts.remote === 'ahead') return facts.local === 'dirty' ? 'conflict' : 'newer_remote';
  if (facts.remote !== 'same') return 'unknown';
  if (facts.local === 'clean') return 'synced';
  if (facts.local === 'dirty') return 'local_dirty';
  return 'unknown';
}

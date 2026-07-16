import type { ChatSyncMeta, SyncStatus } from '../types';

export function computeSyncStatus(input: {
  connected: boolean;
  meta: ChatSyncMeta | null;
  remoteLatestFilename: string | null;
  localMessageCount: number;
}): SyncStatus {
  if (!input.connected) {
    return 'not_connected';
  }
  if (!input.meta?.last_synced_version) {
    return input.localMessageCount > 0 ? 'local_dirty' : 'unknown';
  }
  if (input.remoteLatestFilename && input.remoteLatestFilename > input.meta.last_synced_version) {
    return 'newer_remote';
  }
  if ((input.meta.last_synced_message_count ?? 0) < input.localMessageCount) {
    return 'local_dirty';
  }
  return 'synced';
}

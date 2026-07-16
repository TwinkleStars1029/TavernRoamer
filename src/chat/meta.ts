import { sanitizeRoleKey } from '../roleKey';
import { CHAT_META_KEY, type ChatSyncMeta } from '../types';

export type ChatMetaStore = {
  getChatVariables: () => Record<string, unknown>;
  writeChatVariables: (variables: Record<string, unknown>) => void;
  getCurrentCharacterName: () => string | null;
  getCurrentChatFileName: () => string | null;
};

export function ensureSyncMeta(store: ChatMetaStore, deviceName: string): ChatSyncMeta {
  const variables = store.getChatVariables();
  const existing = variables[CHAT_META_KEY];
  const derivedChatId = deriveChatId(store.getCurrentChatFileName());

  if (isChatSyncMeta(existing)) {
    if (derivedChatId && existing.chat_id !== derivedChatId) {
      const rebound: ChatSyncMeta = {
        ...existing,
        chat_id: derivedChatId,
        device_name: existing.device_name ?? deviceName
      };
      store.writeChatVariables({ [CHAT_META_KEY]: rebound });
      return rebound;
    }
    return existing;
  }

  const characterName = store.getCurrentCharacterName() ?? '未命名角色';
  const meta: ChatSyncMeta = {
    chat_id: derivedChatId ?? buildFallbackChatId(store.getCurrentChatFileName()),
    role_key: sanitizeRoleKey(characterName),
    device_name: deviceName
  };
  store.writeChatVariables({ [CHAT_META_KEY]: meta });
  return meta;
}

export function updateLastSyncedVersion(
  store: ChatMetaStore,
  meta: ChatSyncMeta,
  filename: string,
  messageCount: number
): ChatSyncMeta {
  const next: ChatSyncMeta = {
    ...meta,
    last_synced_version: filename,
    last_synced_message_count: messageCount
  };
  store.writeChatVariables({ [CHAT_META_KEY]: next });
  return next;
}

function isChatSyncMeta(value: unknown): value is ChatSyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Record<string, unknown>;
  return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string';
}

function deriveChatId(fileName: string | null): string | null {
  if (!fileName) {
    return null;
  }

  const normalized = fileName.trim();
  const prefixedMatch = normalized.match(/ - (\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms)(?:\.[^.]+)?$/);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  const bareMatch = normalized.match(/^(\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms)(?:\.[^.]+)?$/);
  return bareMatch?.[1] ?? null;
}

function buildFallbackChatId(fileName: string | null): string {
  const stem = fileName?.trim().replace(/\.[^.]+$/, '');
  if (stem) {
    return stem;
  }
  return `chat_${Date.now()}`;
}

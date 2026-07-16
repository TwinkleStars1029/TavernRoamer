import { CHAT_META_KEY, type ChatSyncMeta } from '../types';

export const CHAT_PACKAGE_FORMAT_VERSION = 1;

export type ChatMessagePackage = Record<string, unknown> & {
  message_id: number;
};

export type ChatPackage = {
  format_version: 1;
  metadata: {
    chat_id: string;
    role_key: string;
    device: string;
    message_count: number;
    packed_at: string;
    last_synced_version?: string;
  };
  chat_variables: Record<string, unknown>;
  chat_worldbook: string | null;
  messages: ChatMessagePackage[];
};

export function createChatPackage(input: {
  meta: ChatSyncMeta;
  deviceName: string;
  messages: ChatMessagePackage[];
  chatVariables: Record<string, unknown>;
  chatWorldbook: string | null;
  packedAt?: Date;
}): ChatPackage {
  const metadata: ChatPackage['metadata'] = {
    chat_id: input.meta.chat_id,
    role_key: input.meta.role_key,
    device: input.deviceName,
    message_count: input.messages.length,
    packed_at: (input.packedAt ?? new Date()).toISOString()
  };
  if (input.meta.last_synced_version) {
    metadata.last_synced_version = input.meta.last_synced_version;
  }
  return {
    format_version: CHAT_PACKAGE_FORMAT_VERSION,
    metadata,
    chat_variables: {
      ...input.chatVariables,
      [CHAT_META_KEY]: input.meta
    },
    chat_worldbook: input.chatWorldbook,
    messages: input.messages.map(message => ({ ...message }))
  };
}

export function unpackChatPackage(value: unknown): ChatPackage {
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  if (!isRecord(parsed)) {
    throw new Error('聊天包不是有效 JSON 物件');
  }
  if (parsed.format_version !== CHAT_PACKAGE_FORMAT_VERSION) {
    throw new Error(`不支援的聊天包版本：${String(parsed.format_version)}`);
  }
  if (!isRecord(parsed.metadata)) {
    throw new Error('聊天包缺少 metadata');
  }
  const metadata = parsed.metadata;
  if (typeof metadata.chat_id !== 'string' || typeof metadata.role_key !== 'string') {
    throw new Error('聊天包 metadata 缺少 chat_id 或 role_key');
  }
  if (!Array.isArray(parsed.messages)) {
    throw new Error('聊天包 messages 不是陣列');
  }
  if (!parsed.messages.every(message => isRecord(message) && Number.isInteger(message.message_id))) {
    throw new Error('聊天包 messages 含有無效樓層');
  }
  return parsed as ChatPackage;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('聊天包 JSON 損壞，無法解析');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

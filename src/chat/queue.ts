import { readScriptVariable, writeScriptVariable } from '../settings';
import type { ChatPackage } from './package';
import type { ChatSyncMeta } from '../types';
import type { TavernChatRef } from './context';

const QUEUE_KEY = 'chat_upload_queue';

export type QueuedChatUpload = {
  id: string;
  path: string[];
  filename: string;
  package: ChatPackage | string;
  mimeType?: string;
  createdAt: string;
  attempts: number;
  operationId?: string;
  status?: 'pending_upload' | 'remote_verified';
  remoteFileId?: string;
  ref?: TavernChatRef;
  meta?: ChatSyncMeta;
  messageCount?: number;
  contentHash?: string;
  hashVersion?: number;
};

export function loadUploadQueue(): QueuedChatUpload[] {
  const value = readScriptVariable(QUEUE_KEY);
  return Array.isArray(value) ? value.filter(isQueuedUpload) : [];
}

export function countQueuedUploadsForChat(meta: Pick<ChatSyncMeta, 'chat_id' | 'role_key'> | null): number {
  if (!meta) return 0;
  return loadUploadQueue().filter(item => {
    if (item.meta) {
      return item.meta.chat_id === meta.chat_id && item.meta.role_key === meta.role_key;
    }
    const path = item.path;
    return path.length >= 4
      && path[path.length - 1] === 'chat'
      && path[path.length - 2] === meta.chat_id
      && path[path.length - 3] === meta.role_key;
  }).length;
}

export function saveUploadQueue(queue: QueuedChatUpload[]): void {
  writeScriptVariable(QUEUE_KEY, queue);
}

export function enqueueUpload(upload: Omit<QueuedChatUpload, 'id' | 'createdAt' | 'attempts'>): QueuedChatUpload {
  const queue = loadUploadQueue();
  const next: QueuedChatUpload = {
    ...upload,
    id: globalThis.crypto?.randomUUID?.() ?? `queue_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    attempts: 0
  };
  const updated = [...queue, next];
  saveUploadQueue(updated);
  return next;
}

export function removeQueuedUpload(id: string): QueuedChatUpload[] {
  const updated = loadUploadQueue().filter(item => item.id !== id);
  saveUploadQueue(updated);
  return updated;
}

export function incrementQueuedUpload(id: string): QueuedChatUpload[] {
  const updated = loadUploadQueue().map(item => (item.id === id ? { ...item, attempts: item.attempts + 1 } : item));
  saveUploadQueue(updated);
  return updated;
}

export function markQueuedUploadVerified(id: string, remoteFileId: string): QueuedChatUpload[] {
  const updated = loadUploadQueue().map(item =>
    item.id === id ? { ...item, status: 'remote_verified' as const, remoteFileId } : item
  );
  saveUploadQueue(updated);
  return updated;
}

export function setQueuedUploadRemoteId(id: string, remoteFileId: string): QueuedChatUpload {
  let matched: QueuedChatUpload | null = null;
  const updated = loadUploadQueue().map(item => {
    if (item.id !== id) return item;
    matched = { ...item, remoteFileId };
    return matched;
  });
  if (!matched) {
    throw new Error('待傳工作不存在，無法保存遠端檔案 ID');
  }
  saveUploadQueue(updated);
  return matched;
}

function isQueuedUpload(value: unknown): value is QueuedChatUpload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    Array.isArray(item.path) &&
    typeof item.filename === 'string' &&
    (typeof item.package === 'object' || typeof item.package === 'string') &&
    typeof item.createdAt === 'string' &&
    typeof item.attempts === 'number' &&
    (item.contentHash === undefined || typeof item.contentHash === 'string') &&
    (item.hashVersion === undefined || typeof item.hashVersion === 'number') &&
    (item.status === undefined || item.status === 'pending_upload' || item.status === 'remote_verified')
  );
}

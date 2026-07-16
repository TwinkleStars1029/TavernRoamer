import { readScriptVariable, writeScriptVariable } from '../settings';
import type { ChatPackage } from './package';

const QUEUE_KEY = 'chat_upload_queue';

export type QueuedChatUpload = {
  id: string;
  path: string[];
  filename: string;
  package: ChatPackage | string;
  mimeType?: string;
  createdAt: string;
  attempts: number;
};

export function loadUploadQueue(): QueuedChatUpload[] {
  const value = readScriptVariable(QUEUE_KEY);
  return Array.isArray(value) ? value.filter(isQueuedUpload) : [];
}

export function saveUploadQueue(queue: QueuedChatUpload[]): void {
  writeScriptVariable(QUEUE_KEY, queue);
}

export function enqueueUpload(upload: Omit<QueuedChatUpload, 'id' | 'createdAt' | 'attempts'>): QueuedChatUpload[] {
  const queue = loadUploadQueue();
  const next: QueuedChatUpload = {
    ...upload,
    id: globalThis.crypto?.randomUUID?.() ?? `queue_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    attempts: 0
  };
  const updated = [...queue, next];
  saveUploadQueue(updated);
  return updated;
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
    typeof item.attempts === 'number'
  );
}

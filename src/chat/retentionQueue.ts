import { readScriptVariable, writeScriptVariable } from '../settings';

const RETENTION_QUEUE_KEY = 'chat_retention_queue';

export type RetentionTask = {
  key: string;
  path: string[];
  attempts: number;
  lastError?: string;
};

export function loadRetentionQueue(): RetentionTask[] {
  const value = readScriptVariable(RETENTION_QUEUE_KEY);
  return Array.isArray(value) ? value.filter(isRetentionTask) : [];
}

export function enqueueRetention(path: string[], error?: unknown): void {
  const key = JSON.stringify(path);
  const queue = loadRetentionQueue();
  const existing = queue.find(item => item.key === key);
  const task: RetentionTask = {
    key,
    path: [...path],
    attempts: (existing?.attempts ?? 0) + 1
  };
  const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  if (message) task.lastError = message;
  writeScriptVariable(RETENTION_QUEUE_KEY, [...queue.filter(item => item.key !== key), task]);
}

export function removeRetention(key: string): void {
  writeScriptVariable(RETENTION_QUEUE_KEY, loadRetentionQueue().filter(item => item.key !== key));
}

function isRetentionTask(value: unknown): value is RetentionTask {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === 'string' &&
    Array.isArray(item.path) &&
    item.path.every(segment => typeof segment === 'string') &&
    typeof item.attempts === 'number'
  );
}

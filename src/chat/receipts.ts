import { readScriptVariable, writeScriptVariable } from '../settings';
import type { ChatSyncMeta } from '../types';
import type { TavernChatRef } from './context';

const RECEIPTS_KEY = 'chat_sync_receipts';

export type ChatSyncReceipt = {
  id: string;
  ref: TavernChatRef;
  meta: ChatSyncMeta;
  filename: string;
  messageCount: number;
  contentHash?: string;
  hashVersion?: number;
  status?: 'pending' | 'superseded';
  createdAt: string;
};

export function loadSyncReceipts(): ChatSyncReceipt[] {
  const value = readScriptVariable(RECEIPTS_KEY);
  return Array.isArray(value) ? value.filter(isReceipt) : [];
}

export function saveSyncReceipt(receipt: ChatSyncReceipt): void {
  const receipts = loadSyncReceipts().filter(item => item.id !== receipt.id);
  writeScriptVariable(RECEIPTS_KEY, [...receipts, receipt]);
}

export function removeSyncReceipt(id: string): void {
  writeScriptVariable(RECEIPTS_KEY, loadSyncReceipts().filter(item => item.id !== id));
}

export function markSyncReceiptSuperseded(id: string): void {
  writeScriptVariable(RECEIPTS_KEY, loadSyncReceipts().map(receipt =>
    receipt.id === id ? { ...receipt, status: 'superseded' as const } : receipt
  ));
}

function isReceipt(value: unknown): value is ChatSyncReceipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const ref = item.ref as Record<string, unknown> | undefined;
  const meta = item.meta as Record<string, unknown> | undefined;
  return (
    typeof item.id === 'string' &&
    typeof item.filename === 'string' &&
    typeof item.messageCount === 'number' &&
    (item.contentHash === undefined || typeof item.contentHash === 'string') &&
    (item.hashVersion === undefined || typeof item.hashVersion === 'number') &&
    (item.status === undefined || item.status === 'pending' || item.status === 'superseded') &&
    typeof item.createdAt === 'string' &&
    !!ref &&
    typeof ref.nativeChatId === 'string' &&
    typeof ref.rawFileName === 'string' &&
    typeof ref.displayFileName === 'string' &&
    typeof ref.avatarUrl === 'string' &&
    !!meta &&
    typeof meta.chat_id === 'string' &&
    typeof meta.role_key === 'string'
  );
}

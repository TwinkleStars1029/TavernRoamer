import type { ChatSyncMeta } from '../types';

export type TavernChatRef = Readonly<{
  nativeChatId: string;
  rawFileName: string;
  displayFileName: string;
  avatarUrl: string;
}>;

export type ChatSyncTarget = Readonly<{
  operationId: string;
  key: string;
  ref: TavernChatRef;
  meta: ChatSyncMeta;
  contextRevision: number;
}>;

export function chatRefKey(ref: TavernChatRef): string {
  return JSON.stringify([ref.avatarUrl, ref.nativeChatId]);
}

export function sameChatRef(left: TavernChatRef, right: TavernChatRef): boolean {
  return left.nativeChatId === right.nativeChatId && left.avatarUrl === right.avatarUrl;
}

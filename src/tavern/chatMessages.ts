import type { ChatPackage } from '../chat/package';
import type { TavernChatRef } from '../chat/context';
import { sameChatRef } from '../chat/context';
import type { ChatSyncPort } from '../chat/ports/ChatSyncPort';
import { getCurrentRawChatInfo } from './chatRef';
import { getTavernGlobals } from './host';
import { omitUndefined, readOptionalBoolean, readOptionalRecord, readOptionalString } from './helpers';

type MessagePort = Pick<ChatSyncPort, 'getMessages' | 'getChatWorldbook' | 'replaceChat'>;

export function createChatMessageAdapter(): MessagePort {
  const globals = getTavernGlobals();
  return {
    getMessages() {
      if (typeof globals.getChatMessages !== 'function') {
        throw new Error('酒館助手聊天訊息 API 不可用');
      }
      return globals.getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
    },
    getChatWorldbook() {
      return typeof globals.getChatWorldbookName === 'function' ? globals.getChatWorldbookName('current') : null;
    },
    async replaceChat(chatPackage, ref) {
      assertCurrentChat(ref);
      if (typeof globals.deleteChatMessages !== 'function' || typeof globals.createChatMessages !== 'function') {
        throw new Error('酒館助手聊天覆寫 API 不可用');
      }
      const lastMessageId = typeof globals.getLastMessageId === 'function' ? globals.getLastMessageId() : -1;
      if (lastMessageId >= 0) {
        await globals.deleteChatMessages(
          Array.from({ length: lastMessageId + 1 }, (_value, index) => index),
          { refresh: 'none' }
        );
      }
      assertCurrentChat(ref);
      await globals.createChatMessages(
        chatPackage.messages.map(message => toCreatableChatMessage(message)),
        { insert_before: 'end', refresh: 'all' }
      );
      assertCurrentChat(ref);
      if (typeof globals.setChatMessages === 'function') {
        await globals.setChatMessages(
          chatPackage.messages.map((message, index) => toRestorableChatMessage(message, index)),
          { refresh: 'all' }
        );
      }
      assertCurrentChat(ref);
      if (chatPackage.chat_worldbook && typeof globals.rebindChatWorldbook === 'function') {
        await globals.rebindChatWorldbook('current', chatPackage.chat_worldbook);
      }
      assertCurrentChat(ref);
      if (typeof globals.replaceVariables === 'function') {
        globals.replaceVariables(chatPackage.chat_variables, { type: 'chat' });
      } else if (typeof globals.insertOrAssignVariables === 'function') {
        globals.insertOrAssignVariables(chatPackage.chat_variables, { type: 'chat' });
      }
    }
  };
}

export function toCreatableChatMessage(message: Record<string, unknown>): Record<string, unknown> {
  const current = currentSwipeSnapshot(message);
  return omitUndefined({
    name: readOptionalString(message.name),
    role: normalizeMessageRole(message),
    is_hidden: readOptionalBoolean(message.is_hidden),
    message: current.message,
    data: current.data,
    extra: current.extra
  });
}

export function toRestorableChatMessage(message: Record<string, unknown>, index: number): Record<string, unknown> {
  const current = currentSwipeSnapshot(message);
  return omitUndefined({ ...message, message_id: index, message: current.message, data: current.data, extra: current.extra });
}

function currentSwipeSnapshot(message: Record<string, unknown>): {
  message: string;
  data: Record<string, unknown> | undefined;
  extra: Record<string, unknown> | undefined;
} {
  const swipes = Array.isArray(message.swipes) ? message.swipes : [];
  const swipeId = clampSwipeId(Number(message.swipe_id ?? 0), swipes.length);
  const swipedMessage = typeof swipes[swipeId] === 'string' ? swipes[swipeId] : undefined;
  const messageText = readOptionalString(message.message) ?? readOptionalString(message.mes) ?? swipedMessage ?? '';
  const swipesData = Array.isArray(message.swipes_data) ? message.swipes_data : [];
  const swipesInfo = Array.isArray(message.swipes_info) ? message.swipes_info : [];
  return {
    message: messageText,
    data: readOptionalRecord(message.data) ?? readOptionalRecord(swipesData[swipeId]),
    extra: readOptionalRecord(message.extra) ?? readOptionalRecord(swipesInfo[swipeId])
  };
}

function normalizeMessageRole(message: Record<string, unknown>): 'system' | 'assistant' | 'user' {
  if (message.role === 'system' || message.role === 'assistant' || message.role === 'user') return message.role;
  if (message.is_user === true) return 'user';
  if (message.is_system === true) return 'system';
  return 'assistant';
}

function clampSwipeId(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, Math.max(0, length - 1));
}

function assertCurrentChat(ref?: TavernChatRef): void {
  if (ref && !sameChatRef(getCurrentRawChatInfo(), ref)) {
    throw new Error('聊天已切換，已中止更新以避免覆蓋其他聊天');
  }
}

export type { ChatPackage };

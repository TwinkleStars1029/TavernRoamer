import type { TavernShellPort } from '../app/TavernShellPort';
import { CHAT_META_KEY, type ChatSyncMeta } from '../types';
import { getTavernGlobals } from './host';

export function createTavernShell(): TavernShellPort {
  let currentChatFileName: string | null = null;
  return {
    isAvailable() {
      const globals = getTavernGlobals();
      return typeof globals.getVariables === 'function' || typeof globals.getCurrentCharacterName === 'function';
    },
    getContext(chatFileName = currentChatFileName) {
      currentChatFileName = chatFileName ?? currentChatFileName;
      const globals = getTavernGlobals();
      const meta = getChatMetaFromGlobals();
      return {
        characterName: typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null,
        characterId: typeof globals.getCurrentCharacterId === 'function' ? globals.getCurrentCharacterId() : null,
        chatFileName: currentChatFileName,
        chatId: meta?.chat_id ?? null,
        lastMessageId: typeof globals.getLastMessageId === 'function' ? globals.getLastMessageId() : null,
        status: 'unknown'
      };
    },
    getChatMeta: getChatMetaFromGlobals,
    writeChatMeta(meta) {
      const globals = getTavernGlobals();
      if (typeof globals.insertOrAssignVariables !== 'function') throw new Error('酒館助手 chat 變數 API 不可用');
      globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
    },
    onChatChanged(handler) {
      const globals = getTavernGlobals();
      const eventName = globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed';
      if (typeof globals.eventOn !== 'function') return () => undefined;
      const listener = (chatFileName: string | null) => {
        currentChatFileName = chatFileName ?? null;
        handler(currentChatFileName);
      };
      const subscription = globals.eventOn(eventName, listener);
      return () => subscription?.stop?.();
    },
    onChatContentChanged(handler) {
      const globals = getTavernGlobals();
      if (typeof globals.eventOn !== 'function') return () => undefined;
      const eventNames = [
        globals.tavern_events?.MESSAGE_SENT ?? 'message_sent',
        globals.tavern_events?.MESSAGE_RECEIVED ?? 'message_received',
        globals.tavern_events?.MESSAGE_EDITED ?? 'message_edited',
        globals.tavern_events?.MESSAGE_DELETED ?? 'message_deleted',
        globals.tavern_events?.MESSAGE_SWIPED ?? 'message_swiped'
      ];
      const subscriptions = [...new Set(eventNames)].flatMap(eventName => {
        try {
          return [globals.eventOn(eventName, handler)];
        } catch {
          return [];
        }
      });
      return () => subscriptions.forEach(subscription => subscription?.stop?.());
    },
    onMessageCompleted(handler) {
      const globals = getTavernGlobals();
      const eventName = globals.tavern_events?.GENERATION_ENDED ?? globals.tavern_events?.MESSAGE_RECEIVED ?? 'generation_ended';
      if (typeof globals.eventOn !== 'function') return () => undefined;
      const subscription = globals.eventOn(eventName, handler);
      return () => subscription?.stop?.();
    },
    notify(message, kind = 'info') {
      const notifier = getTavernGlobals().toastr?.[kind];
      if (typeof notifier === 'function') notifier(message);
      else console.log(`[TavernRoamer] ${message}`);
    }
  };
}

export function getChatMetaFromGlobals(): ChatSyncMeta | null {
  const globals = getTavernGlobals();
  if (typeof globals.getVariables !== 'function') return null;
  const value = globals.getVariables({ type: 'chat' })?.[CHAT_META_KEY];
  if (!value || typeof value !== 'object') return null;
  const meta = value as Record<string, unknown>;
  return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string' ? value as ChatSyncMeta : null;
}

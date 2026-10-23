import type { ChatSyncMeta, TavernContext } from '../types';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

/** SillyTavern shell functions used by the application composition root. */
export type TavernShellPort = {
  isAvailable: () => boolean;
  getContext: (chatFileName?: string | null) => TavernContext;
  getChatMeta: () => ChatSyncMeta | null;
  writeChatMeta: (meta: ChatSyncMeta) => void;
  onChatChanged: (handler: (chatFileName: string | null) => void) => () => void;
  onChatContentChanged: (handler: () => void) => () => void;
  onMessageCompleted: (handler: () => void) => () => void;
  notify: (message: string, kind?: ToastKind) => void;
};

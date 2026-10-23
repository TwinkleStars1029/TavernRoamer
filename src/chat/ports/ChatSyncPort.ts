import type { ChatMetaStore } from '../meta';
import type { ChatPackage, ChatMessagePackage } from '../package';
import type { TavernChatRef } from '../context';

export type RawChatFile = {
  content: string;
  messageCount: number;
};

/** Host capabilities used by chat synchronization only. */
export type ChatSyncPort = ChatMetaStore & {
  getMessages: () => ChatMessagePackage[];
  getChatWorldbook: () => string | null;
  getCurrentChatRef?: () => TavernChatRef;
  isCurrentChat?: (ref: TavernChatRef) => boolean;
  exportRawChat: (ref?: TavernChatRef) => Promise<RawChatFile>;
  replaceRawChat: (content: string, ref?: TavernChatRef) => Promise<void>;
  replaceChat: (chatPackage: ChatPackage, ref?: TavernChatRef) => Promise<void>;
};

import type { ChatSyncPort } from '../chat/ports/ChatSyncPort';
import { sameChatRef, type TavernChatRef } from '../chat/context';
import { getCurrentRawChatInfo } from './chatRef';
import { createChatMessageAdapter } from './chatMessages';
import { createChatMetaAdapter } from './chatMeta';
import { createRawChatAdapter } from './rawChat';

export function createChatSyncAdapter(): ChatSyncPort {
  return {
    ...createChatMetaAdapter(),
    getCurrentChatRef: getCurrentRawChatInfo,
    isCurrentChat(ref: TavernChatRef) {
      try { return sameChatRef(getCurrentRawChatInfo(), ref); } catch { return false; }
    },
    ...createChatMessageAdapter(),
    ...createRawChatAdapter()
  };
}

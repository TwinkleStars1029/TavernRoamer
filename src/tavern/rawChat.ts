import { sameChatRef, type TavernChatRef } from '../chat/context';
import type { ChatSyncPort } from '../chat/ports/ChatSyncPort';
import { getCurrentRawChatInfo } from './chatRef';
import { getSillyTavernContext } from './host';
import { postTavernJson } from './request';
import { parseRawChatContent } from '../chat/snapshot';

type RawChatPort = Pick<ChatSyncPort, 'exportRawChat' | 'replaceRawChat'>;

export function createRawChatAdapter(): RawChatPort {
  return {
    async exportRawChat(ref) {
      const chatInfo = ref ?? getCurrentRawChatInfo();
      const response = await postTavernJson('/api/chats/export', {
        file: chatInfo.rawFileName,
        avatar_url: chatInfo.avatarUrl,
        exportfilename: chatInfo.rawFileName,
        format: 'jsonl',
        is_group: false
      });
      if (!response.ok) throw new Error(`SillyTavern raw chat export failed: ${response.status}`);
      const result = await response.json() as { result?: unknown; message?: unknown };
      if (typeof result.result !== 'string') {
        throw new Error(typeof result.message === 'string' ? result.message : 'SillyTavern raw chat export did not return JSONL');
      }
      return { content: result.result, messageCount: countRawChatMessages(result.result) };
    },
    async replaceRawChat(content, ref) {
      const chatInfo = ref ?? getCurrentRawChatInfo();
      const response = await postTavernJson('/api/chats/save', {
        avatar_url: chatInfo.avatarUrl,
        file_name: chatInfo.nativeChatId,
        chat: parseRawChatMessages(content),
        force: true
      });
      if (!response.ok) throw new Error(`SillyTavern raw chat save failed: ${response.status}`);
      let shouldReload = !ref;
      try {
        shouldReload ||= Boolean(ref && sameChatRef(getCurrentRawChatInfo(), ref));
      } catch {
        shouldReload = false;
      }
      if (shouldReload) await getSillyTavernContext()?.reloadCurrentChat?.();
    }
  };
}

export function parseRawChatMessages(content: string): Array<Record<string, unknown>> {
  return parseRawChatContent(content).rows;
}

export function countRawChatMessages(content: string): number {
  return parseRawChatContent(content).messageCount;
}

export type { TavernChatRef };

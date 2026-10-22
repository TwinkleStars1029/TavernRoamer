import type { ChatMetaStore } from '../chat/meta';
import { getCurrentRawChatInfo } from './chatRef';
import { getTavernGlobals } from './host';

export function createChatMetaAdapter(): ChatMetaStore {
  const globals = getTavernGlobals();
  return {
    getChatVariables() {
      return typeof globals.getVariables === 'function' ? { ...globals.getVariables({ type: 'chat' }) } : {};
    },
    writeChatVariables(variables) {
      if (typeof globals.insertOrAssignVariables !== 'function') throw new Error('酒館助手 chat 變數 API 不可用');
      globals.insertOrAssignVariables(variables, { type: 'chat' });
    },
    getCurrentCharacterName() {
      return typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
    },
    getCurrentChatFileName() {
      return getCurrentRawChatInfo().displayFileName;
    }
  };
}

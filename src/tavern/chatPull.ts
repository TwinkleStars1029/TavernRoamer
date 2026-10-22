import type { ChatPullPort } from '../chat/ports/ChatPullPort';
import { CHAT_META_KEY } from '../types';
import { getCurrentRawChatInfo } from './chatRef';
import { getSillyTavernContext, getTavernGlobals } from './host';
import { readOptionalString } from './helpers';
import { createRawChatAdapter, parseRawChatMessages } from './rawChat';
import { postTavernJson } from './request';

export function createTavernPullAdapter(): ChatPullPort {
  const globals = getTavernGlobals();
  const adapter = {
    listCharacterNames() {
      return adapter.listCharacters().map(character => character.name);
    },
    listCharacters() {
      const context = getSillyTavernContext();
      if (!Array.isArray(context?.characters)) return [];
      return context.characters.flatMap((character: Record<string, unknown>) => {
        const name = readOptionalString(character?.name);
        const avatarUrl = readOptionalString(character?.avatar);
        return name && avatarUrl ? [{ name, avatarUrl }] : [];
      });
    },
    async selectCharacter(character) {
      const context = getSillyTavernContext();
      if (!Array.isArray(context?.characters) || typeof context?.selectCharacterById !== 'function') {
        throw new Error('酒館 selectCharacterById API 不可用');
      }
      const index = context.characters.findIndex((candidate: Record<string, unknown>) =>
        candidate?.name === character.name && candidate?.avatar === character.avatarUrl
      );
      if (index < 0) throw new Error(`本地找不到角色卡：${character.name}`);
      await context.selectCharacterById(index);
    },
    getCurrentCharacterRef() {
      const context = getSillyTavernContext();
      const characterId = readOptionalString(context?.characterId);
      const index = characterId === undefined ? Number.NaN : Number(characterId);
      const character = Array.isArray(context?.characters) && Number.isInteger(index) ? context.characters[index] : null;
      const name = readOptionalString(character?.name) ?? adapter.getCurrentCharacterName();
      const avatarUrl = readOptionalString(character?.avatar);
      return name && avatarUrl ? { name, avatarUrl } : null;
    },
    getCurrentCharacterName() {
      const context = getSillyTavernContext();
      const globalName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
      return globalName ?? readOptionalString(context?.name2) ?? null;
    },
    async listCharacterChatFiles(character) {
      const response = await postTavernJson('/api/characters/chats', {
        avatar_url: character.avatarUrl,
        simple: true
      });
      if (!response.ok) throw new Error(`SillyTavern 聊天清單讀取失敗: ${response.status}`);
      const result = await response.json() as unknown;
      const rows = Array.isArray(result) ? result : Object.values(result as Record<string, unknown>);
      return rows.map(row => readOptionalString((row as Record<string, unknown>)?.file_name)).filter((name): name is string => Boolean(name));
    },
    async createChatFile(character, fileName, rawJsonl) {
      const response = await postTavernJson('/api/chats/save', {
        avatar_url: character.avatarUrl,
        file_name: fileName,
        chat: parseRawChatMessages(rawJsonl),
        force: true
      });
      if (!response.ok) throw new Error(`SillyTavern 聊天檔建立失敗: ${response.status}`);
    },
    async openChatFile(character, fileName) {
      const context = getSillyTavernContext();
      if (typeof context?.openCharacterChat !== 'function') {
        throw new Error('酒館 openCharacterChat API 不可用，無法開啟從雲端建立的聊天');
      }
      const current = adapter.getCurrentCharacterRef();
      if (!current || current.avatarUrl !== character.avatarUrl) throw new Error('角色已切換，未開啟雲端聊天');
      await context.openCharacterChat(fileName);
    },
    getCurrentChatFileName() {
      try { return getCurrentRawChatInfo().displayFileName; } catch { return null; }
    },
    exportRawChat() {
      return createRawChatAdapter().exportRawChat();
    },
    async applyCharacter(snapshot) {
      if (typeof globals.createOrReplaceCharacter !== 'function') throw new Error('Character restore API is unavailable');
      await globals.createOrReplaceCharacter(snapshot.characterName ?? 'Imported Character', snapshot.data, { render: 'none' });
    },
    writeChatMeta(meta) {
      if (typeof globals.insertOrAssignVariables !== 'function') throw new Error('酒館助手 chat 變數 API 不可用');
      globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
    }
  } as ChatPullPort;
  adapter.selectCharacterByName = async name => {
    const matches = adapter.listCharacters().filter(character => character.name === name);
    if (matches.length !== 1) throw new Error(matches.length === 0 ? `本地找不到角色卡：${name}` : `本地有多張同名角色卡：${name}`);
    await adapter.selectCharacter(matches[0]!);
  };
  adapter.listCurrentCharacterChatFiles = async () => {
    const current = adapter.getCurrentCharacterRef();
    if (!current) throw new Error('目前沒有可辨識的角色卡');
    return adapter.listCharacterChatFiles(current);
  };
  adapter.createAndOpenChatFile = async (fileName, rawJsonl) => {
    const current = adapter.getCurrentCharacterRef();
    if (!current) throw new Error('目前沒有可辨識的角色卡');
    const context = getSillyTavernContext();
    if (typeof context?.openCharacterChat !== 'function') throw new Error('酒館 openCharacterChat API 不可用，無法開啟從雲端建立的聊天');
    await adapter.createChatFile(current, fileName, rawJsonl);
    await adapter.openChatFile(current, fileName);
  };
  return adapter;
}

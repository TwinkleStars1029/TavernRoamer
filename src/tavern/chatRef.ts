import type { TavernChatRef } from '../chat/context';
import { getSillyTavernContext } from './host';
import { readOptionalString } from './helpers';

export function getCurrentCharacterAvatarUrl(): string {
  const context = getSillyTavernContext();
  const characterId = readOptionalString(context?.characterId);
  const characterIndex = characterId === undefined ? Number.NaN : Number(characterId);
  const character =
    Array.isArray(context?.characters) && Number.isInteger(characterIndex) ? context.characters[characterIndex] : null;
  const avatarUrl = readOptionalString(character?.avatar);
  if (!avatarUrl) {
    throw new Error('無法取得目前角色的 avatar');
  }
  return avatarUrl;
}

export function getCurrentRawChatInfo(): TavernChatRef {
  const context = getSillyTavernContext();
  const chatId = readOptionalString(context?.getCurrentChatId?.()) ?? readOptionalString(context?.chatId);
  const contextFileName =
    readOptionalString(context?.chatFileName) ??
    readOptionalString(context?.chat_file_name) ??
    readOptionalString(context?.chat?.file_name);
  const avatarUrl = getCurrentCharacterAvatarUrl();
  if (!chatId) {
    throw new Error('無法取得目前 SillyTavern 原始聊天檔資訊');
  }
  return {
    nativeChatId: chatId,
    rawFileName: chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`,
    displayFileName: contextFileName ?? (chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`),
    avatarUrl
  };
}

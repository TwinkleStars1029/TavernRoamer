import type { CharacterSnapshot } from '../environment/types';
import type { ChatSyncMeta } from '../types';

export type TavernPullAdapter = {
  listCharacterNames: () => string[];
  selectCharacterByName: (name: string) => Promise<void>;
  getCurrentCharacterName: () => string | null;
  listCurrentCharacterChatFiles: () => Promise<string[]>;
  createAndOpenChatFile: (fileName: string, rawJsonl: string) => Promise<void>;
  applyCharacter: (snapshot: CharacterSnapshot) => Promise<void>;
  writeChatMeta: (meta: ChatSyncMeta) => void;
};

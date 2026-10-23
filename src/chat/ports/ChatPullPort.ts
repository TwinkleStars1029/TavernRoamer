import type { CharacterSnapshot } from '../../environment/types';
import type { ChatSyncMeta } from '../../types';

export type LocalCharacterRef = Readonly<{
  name: string;
  avatarUrl: string;
}>;

/** Host capabilities used when materializing a cloud chat locally. */
export type ChatPullPort = {
  listCharacterNames: () => string[];
  listCharacters: () => LocalCharacterRef[];
  selectCharacter: (character: LocalCharacterRef) => Promise<void>;
  getCurrentCharacterRef: () => LocalCharacterRef | null;
  getCurrentCharacterName: () => string | null;
  listCharacterChatFiles: (character: LocalCharacterRef) => Promise<string[]>;
  createChatFile: (character: LocalCharacterRef, fileName: string, rawJsonl: string) => Promise<void>;
  openChatFile: (character: LocalCharacterRef, fileName: string) => Promise<void>;
  getCurrentChatFileName?: () => string | null;
  exportRawChat: () => Promise<{ content: string; messageCount: number }>;
  applyCharacter: (snapshot: CharacterSnapshot) => Promise<void>;
  writeChatMeta: (meta: ChatSyncMeta) => void;
  /** Compatibility helpers for older callers. New workflows must use fixed character references. */
  selectCharacterByName: (name: string) => Promise<void>;
  listCurrentCharacterChatFiles: () => Promise<string[]>;
  createAndOpenChatFile: (fileName: string, rawJsonl: string) => Promise<void>;
};

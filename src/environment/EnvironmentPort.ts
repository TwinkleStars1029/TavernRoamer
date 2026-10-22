import type { ChatMetaStore } from '../chat/meta';
import type {
  CharacterSnapshot,
  PersonaSnapshot,
  PresetSnapshot,
  RegexSnapshot,
  WorldSnapshot
} from './types';

export type EnvironmentExportPort = ChatMetaStore & {
  exportCharacter: () => Promise<CharacterSnapshot>;
  exportWorld: () => Promise<WorldSnapshot>;
  exportPersona: () => Promise<PersonaSnapshot>;
  exportPreset: () => Promise<PresetSnapshot>;
  exportRegex: () => Promise<RegexSnapshot>;
};

export type EnvironmentApplyPort = {
  applyCharacter: (snapshot: CharacterSnapshot, contextKey?: string) => Promise<void>;
  applyWorld: (snapshot: WorldSnapshot, contextKey?: string) => Promise<void>;
  applyPersona: (snapshot: PersonaSnapshot, contextKey?: string) => Promise<void>;
  applyPreset: (snapshot: PresetSnapshot, contextKey?: string) => Promise<void>;
  applyRegex: (snapshot: RegexSnapshot, contextKey?: string) => Promise<void>;
};

export type EnvironmentContextPort = {
  captureEnvironmentContext?: () => string;
  isEnvironmentContextCurrent?: (contextKey: string) => boolean;
};

export type EnvironmentPort = EnvironmentExportPort & EnvironmentApplyPort & EnvironmentContextPort;

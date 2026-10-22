import type { EnvironmentItemKind } from '../environment/types';

export type TavernEventDiagnostics = {
  missing: string[];
  chatChanged: string;
  generationEnded: string;
};

export type CharacterRoundtripProbe = {
  supported: boolean;
  selected: boolean;
  tempName: string | null;
  copiedExtensions: boolean;
  cleanupError: string | null;
};

/** Host probes reserved for self-checks; application services do not depend on these. */
export type TavernDiagnosticsPort = {
  environmentRestoreMissing: (kind: EnvironmentItemKind) => string[];
  characterRoundtrip: () => Promise<CharacterRoundtripProbe>;
  chatReadMissing: () => string[];
  eventDiagnostics: () => TavernEventDiagnostics;
  chatReplaceMissing: () => string[];
  setChatMessages: (messages: Array<Record<string, unknown>>) => Promise<void>;
  pullMissing: () => string[];
  hasContext: () => boolean;
};

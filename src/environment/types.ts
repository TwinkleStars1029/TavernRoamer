export const ENVIRONMENT_ITEM_KINDS = ['character', 'world', 'persona', 'preset', 'regex'] as const;

export type EnvironmentItemKind = (typeof ENVIRONMENT_ITEM_KINDS)[number];

export type EnvironmentSnapshotBase = {
  kind: EnvironmentItemKind;
  exportedAt: string;
};

export type CharacterSnapshot = EnvironmentSnapshotBase & {
  kind: 'character';
  characterName: string | null;
  data: unknown;
};

export type WorldBindingsSnapshot = {
  chat: string | null;
  char_primary: string | null;
  char_additional: string[];
  global_enabled: string[];
};

export type WorldSnapshot = EnvironmentSnapshotBase & {
  kind: 'world';
  bindings: WorldBindingsSnapshot;
  books: Record<string, unknown>;
};

export type PersonaSnapshot = EnvironmentSnapshotBase & {
  kind: 'persona';
  name: string | null;
  data: unknown;
};

export type PresetSnapshot = EnvironmentSnapshotBase & {
  kind: 'preset';
  name: string | null;
  data: unknown;
};

export type RegexSnapshot = EnvironmentSnapshotBase & {
  kind: 'regex';
  scope: 'global';
  items: unknown[];
};

export type EnvironmentSnapshot =
  | CharacterSnapshot
  | WorldSnapshot
  | PersonaSnapshot
  | PresetSnapshot
  | RegexSnapshot;

export type EnvironmentProgressStep = 'export' | 'upload' | 'backup_current' | 'download' | 'apply';

export type EnvironmentProgressEvent = {
  kind: EnvironmentItemKind;
  step: EnvironmentProgressStep;
  state: 'start' | 'done' | 'error';
  filename?: string;
  error?: string;
};

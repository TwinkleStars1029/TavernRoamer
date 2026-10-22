export const ENVIRONMENT_ITEM_KINDS = ['character', 'world', 'persona', 'preset', 'regex'] as const;

export type EnvironmentItemKind = (typeof ENVIRONMENT_ITEM_KINDS)[number];

export type EnvironmentSnapshotBase = {
  schemaVersion?: 1;
  kind: EnvironmentItemKind;
  exportedAt: string;
};

export type CharacterSnapshot = EnvironmentSnapshotBase & {
  kind: 'character';
  characterName: string | null;
  data: unknown;
  /** Embedded image bytes make the avatar portable across SillyTavern installations. */
  avatarImage?: { mimeType: string; base64: string };
};

export type WorldBindingsSnapshot = {
  chat: string | null;
  char_primary: string | null;
  char_additional: string[];
  global_enabled: string[];
};

export type WorldSnapshot = EnvironmentSnapshotBase & {
  kind: 'world';
  /** Missing on older backups, whose books contain Tavern Helper entry arrays. */
  format?: 'sillytavern-worldinfo-v1' | 'tavern-helper-worldbook-v1';
  bindings: WorldBindingsSnapshot;
  books: Record<string, unknown>;
};

export type PersonaSnapshot = EnvironmentSnapshotBase & {
  kind: 'persona';
  name: string | null;
  data: unknown;
  /** Embedded image bytes make the avatar portable across SillyTavern installations. */
  avatarImage?: { mimeType: string; base64: string };
};

export type PresetSnapshot = EnvironmentSnapshotBase & {
  kind: 'preset';
  name: string | null;
  /** Missing on the oldest backups. Tavern Helper v1 is retained for restore compatibility. */
  format?: 'sillytavern-openai-preset-v1' | 'sillytavern-textgenerationwebui-preset-v1' | 'tavern-helper-preset-v1';
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

export type EnvironmentProgressStep = 'export' | 'upload' | 'download' | 'validate' | 'backup_current' | 'check_context' | 'apply';

export type EnvironmentProgressEvent = {
  kind: EnvironmentItemKind;
  step: EnvironmentProgressStep;
  state: 'start' | 'done' | 'error';
  filename?: string;
  error?: string;
};

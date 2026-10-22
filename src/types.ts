export const SCRIPT_ID = 'tavern-roamer';
export const SETTINGS_KEY = 'tavern_roamer_settings';
export const CHAT_META_KEY = '_drive_sync';

export type SyncStatus =
  | 'not_connected'
  | 'untracked'
  | 'remote_available'
  | 'synced'
  | 'newer_remote'
  | 'local_dirty'
  | 'conflict'
  | 'remote_missing'
  | 'remote_mismatch'
  | 'check_failed'
  | 'unknown';

export type AppearanceSettings = {
  mode: 'tavern' | 'light' | 'dark';
  accentColor: string | null;
  tone: 'soft' | 'standard' | 'vivid';
};

export type Settings = {
  appearance?: AppearanceSettings;
  deviceName: string;
  googleClientId: string;
  autoSyncEnabled: boolean;
  autoSyncEveryN: number;
  chatRetention: {
    mode: 'keep_all' | 'keep_latest_n';
    latestN: number;
  };
};

export type DriveConnectionState = {
  connected: boolean;
  email: string | null;
  error: string | null;
};

export type ChatSyncMeta = {
  chat_id: string;
  role_key: string;
  last_synced_version?: string;
  device_name?: string;
  last_synced_message_count?: number;
  last_synced_content_hash?: string;
  last_synced_hash_version?: number;
};

export type TavernContext = {
  characterName: string | null;
  characterId: string | null;
  chatFileName: string | null;
  chatId: string | null;
  lastMessageId: number | null;
  status: SyncStatus;
};

// 狀態列額外資訊（由 index.ts 的 refreshPanelContext 傳入面板，非 TavernContext 本體欄位）
export type PanelStatusInfo = {
  lastSyncedVersion: string | null;
  pendingUploads: number;
};

export type SelfCheckStatus = 'pass' | 'fail' | 'blocked' | 'not_applicable';
export type SelfCheckCategory =
  | 'settings'
  | 'drive'
  | 'chat'
  | 'environment_backup'
  | 'environment_restore'
  | 'cloud_chat'
  | 'autosync'
  | 'advanced';
export type SelfCheckSafety = 'read_only' | 'temporary_write' | 'destructive';
export type SelfCheckMode = 'quick' | 'advanced';
export type SelfCheckAction = 'open_settings' | 'connect_drive' | 'select_chat';

export type SelfCheckResult = {
  id: string;
  label: string;
  category: SelfCheckCategory;
  safety: SelfCheckSafety;
  mode: SelfCheckMode;
  status: SelfCheckStatus;
  message: string;
  remediation?: string;
  action?: SelfCheckAction;
  details?: unknown;
  startedAt: string;
  durationMs: number;
};

export type SelfCheckCase = {
  id: string;
  label: string;
  category: SelfCheckCategory;
  safety: SelfCheckSafety;
  mode: SelfCheckMode;
  timeoutMs?: number;
  run: () => Promise<
    Omit<
      SelfCheckResult,
      'id' | 'label' | 'category' | 'safety' | 'mode' | 'startedAt' | 'durationMs'
    >
  >;
};

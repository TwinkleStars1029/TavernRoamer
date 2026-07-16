export const SCRIPT_ID = 'tavern-roamer';
export const SETTINGS_KEY = 'tavern_roamer_settings';
export const CHAT_META_KEY = '_drive_sync';

export type SyncStatus = 'not_connected' | 'synced' | 'newer_remote' | 'local_dirty' | 'unknown';

export type Settings = {
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

export type SelfCheckStatus = 'pass' | 'fail' | 'skip';

export type SelfCheckResult = {
  id: string;
  label: string;
  status: SelfCheckStatus;
  message: string;
  details?: unknown;
  durationMs: number;
};

export type SelfCheckCase = {
  id: string;
  label: string;
  run: () => Promise<Omit<SelfCheckResult, 'id' | 'label' | 'durationMs'>>;
};

import type { EnvironmentItemKind, EnvironmentProgressEvent } from '../environment/types';
import type {
  RestorePointBatch,
  RestorePointChatSummary,
  RestorePointCleanupPreview,
  RestorePointMutationResult,
  RestorePointSelection,
  RestorePointTarget
} from '../restorePoints/types';
export type { RestorePointBatch, RestorePointChatSummary } from '../restorePoints/types';
import type {
  DriveConnectionState,
  PanelStatusInfo,
  SelfCheckMode,
  SelfCheckResult,
  Settings,
  TavernContext
} from '../types';

export type EnvironmentBackupViewResult = {
  kind: EnvironmentItemKind;
  status: 'done' | 'error';
  filename?: string;
  error?: string;
};

export type EnvironmentAvailabilityView = {
  kind: EnvironmentItemKind;
  available: boolean;
  latestFilename: string | null;
};

export type ChatUploadPreparationView = {
  preparationId: string;
  isFirstUpload: boolean;
  latestChatFilename: string | null;
  environment: EnvironmentAvailabilityView[];
  recoveryStatus: 'ready' | 'missing_character' | 'first_upload';
};

export type ChatUploadWorkflowViewResult = {
  status: 'done' | 'partial' | 'queued' | 'aborted';
  environmentResults: EnvironmentBackupViewResult[];
  chat: null | {
    status: 'done' | 'queued' | 'partial';
    detail: string;
  };
  recoveryStatus: 'ready' | 'missing_character';
};

export type EnvironmentRestoreViewResult = {
  items: Array<{
    kind: EnvironmentItemKind;
    status: 'done' | 'error' | 'aborted' | 'skipped';
    filename?: string;
    error?: string;
  }>;
  restorePointPath: string[];
};

export type CloudRoleViewEntry = { roleKey: string };
export type CloudChatViewEntry = {
  chatId: string;
  versionCount: number;
  latest: { filename: string; device?: string; [key: string]: unknown } | null;
};
export type PullViewResult = { filename: string; chatFileName: string; characterRestored: boolean };
export type ChatDownloadViewResult = {
  filename: string;
  status: 'done' | 'partial';
  detail: string;
};

export type SelfCheckProgressView = {
  phase: 'start' | 'complete';
  completed: number;
  total: number;
  currentId: string;
  currentLabel: string;
  result?: SelfCheckResult;
};

export type PanelOptions = {
  getContext: () => TavernContext;
  getDriveState: () => DriveConnectionState;
  getSettings: () => Settings;
  saveSettings: (settings: Settings) => Settings;
  onSave: (settings: Settings) => void;
  onConnectDrive: () => Promise<DriveConnectionState>;
  /** 重新核對目前聊天與雲端的同步狀態；完成後應透過 updateContext 回報新狀態。 */
  onRefreshStatus: () => Promise<void>;
  /** 立即補傳待傳佇列；完成後應透過 updateContext 回報新的待傳筆數。 */
  onFlushQueue: () => Promise<{ uploaded: number; remaining: number }>;
  onPrepareChatUpload: () => Promise<ChatUploadPreparationView>;
  onConfirmChatUpload: (
    input: {
      preparationId: string;
      selectedEnvironment: EnvironmentItemKind[];
      chatOnly: boolean;
    },
    onProgress: (event: EnvironmentProgressEvent) => void
  ) => Promise<ChatUploadWorkflowViewResult>;
  onBackupEnvironment: (
    items: EnvironmentItemKind[],
    onProgress: (event: EnvironmentProgressEvent) => void
  ) => Promise<EnvironmentBackupViewResult[]>;
  onRestoreEnvironment: (
    items: EnvironmentItemKind[],
    onProgress: (event: EnvironmentProgressEvent) => void
  ) => Promise<EnvironmentRestoreViewResult>;
  onPreviewRestore: (items: EnvironmentItemKind[]) => Promise<Record<EnvironmentItemKind, string | null>>;
  onDownloadLatest: () => Promise<ChatDownloadViewResult>;
  onListCloudRoles: () => Promise<CloudRoleViewEntry[]>;
  onListCloudChats: (roleKey: string) => Promise<CloudChatViewEntry[]>;
  onPullChat: (roleKey: string, chatId: string) => Promise<PullViewResult>;
  onListRestorePointChats: () => Promise<RestorePointChatSummary[]>;
  onListRestorePointBatches: (target: RestorePointTarget) => Promise<RestorePointBatch[]>;
  onPreviewRestorePointCleanup: (days: number, target?: RestorePointTarget) => Promise<RestorePointCleanupPreview>;
  onTrashRestorePointFiles: (files: RestorePointSelection[]) => Promise<RestorePointMutationResult>;
  onDeleteRestorePointFilesPermanently: (files: RestorePointSelection[]) => Promise<RestorePointMutationResult>;
  onRunSelfChecks: (
    mode: SelfCheckMode,
    onProgress: (progress: SelfCheckProgressView) => void
  ) => Promise<SelfCheckResult[]>;
  onClose?: () => void;
};

export type PanelHealth = {
  mounted: boolean;
  hasInlineDrawer: boolean;
  toggleReady: boolean;
  details: Record<string, unknown>;
};

export type PanelController = {
  mount: (options?: { floating?: boolean }) => void;
  unmount: () => void;
  updateContext: (context: TavernContext, info?: PanelStatusInfo) => void;
  updateDriveStatus: (state: DriveConnectionState) => void;
  invalidateUploadPreparation: () => void;
  probe: () => PanelHealth;
};

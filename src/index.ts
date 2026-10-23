import { GoogleIdentityAuth } from './auth/GoogleIdentityAuth';
import { AutoSyncController } from './chat/AutoSyncController';
import { ChatSyncService } from './chat/ChatSyncService';
import { ChatPullService } from './chat/ChatPullService';
import { ChatUploadReadinessService } from './chat/ChatUploadReadinessService';
import { ChatUploadWorkflow } from './chat/ChatUploadWorkflow';
import { listCloudChats, listCloudRoles } from './chat/browse';
import { countQueuedUploadsForChat } from './chat/queue';
import { computeSyncStatus } from './chat/status';
import { GoogleDriveClient } from './drive/GoogleDriveClient';
import { DriveService } from './drive/DriveService';
import { EnvironmentBackupService } from './environment/EnvironmentBackupService';
import { EnvironmentRestoreService } from './environment/EnvironmentRestoreService';
import { RestorePointService } from './restorePoints/RestorePointService';
import { ENVIRONMENT_ITEM_KINDS, type EnvironmentItemKind } from './environment/types';
import {
  registerApiSpikeSelfChecks,
  registerChatSelfChecks,
  registerDriveSelfChecks,
  registerPhase0SelfChecks,
  registerPullSelfChecks,
  runSelfChecks
} from './selfCheck';
import { loadSettings, saveSettings } from './settings';
import { createTavernServices } from './tavern';
import { markContextChanged } from './contextRevision';
import type { DriveConnectionState } from './types';
import { createPanel } from './ui';

const LAUNCHER_ID = 'tavern-roamer-launcher';
const LAUNCHER_LABEL = 'TavernRoamer';
const LAUNCHER_RETRY_MS = 500;

const tavernServices = createTavernServices();

registerPhase0SelfChecks();
registerApiSpikeSelfChecks(tavernServices);
registerChatSelfChecks(tavernServices);
registerPullSelfChecks(tavernServices);

const tavern = tavernServices.shell;
const auth = new GoogleIdentityAuth(() => loadSettings().googleClientId);
const driveClient = new GoogleDriveClient({ tokenProvider: auth });
const driveService = new DriveService(driveClient);
const chatSync = new ChatSyncService(tavernServices.chatSync, driveService);
const environmentBackup = new EnvironmentBackupService(tavernServices.environment, driveService);
const environmentRestore = new EnvironmentRestoreService(tavernServices.environment, driveService);
const chatUploadReadiness = new ChatUploadReadinessService(driveService);
const chatUploadWorkflow = new ChatUploadWorkflow(chatSync, environmentBackup, chatUploadReadiness);
const restorePoints = new RestorePointService(driveService);
const chatPull = new ChatPullService(tavernServices.chatPull, driveService);
let driveState: DriveConnectionState = { connected: false, email: null, error: null };
let panelRefreshRevision = 0;
let launcherRetryId: number | null = null;

registerDriveSelfChecks(driveService, () => driveState);

const panel = createPanel({
  getContext: () => tavern.getContext(),
  getDriveState: () => driveState,
  getSettings: loadSettings,
  saveSettings,
  onRunSelfChecks: (mode, onProgress) => runSelfChecks({ mode, onProgress }),
  onSave: () => tavern.notify('設定已儲存', 'success'),
  onConnectDrive: async () => {
    await auth.connect();
    const email = await driveClient.getAccountEmail();
    driveState = { connected: true, email, error: null };
    await chatSync.flushQueue();
    await refreshPanelContext();
    return driveState;
  },
  onRefreshStatus: () => refreshPanelContext(),
  onFlushQueue: async () => {
    try {
      return await chatSync.flushQueue();
    } finally {
      await refreshPanelContext();
    }
  },
  onPrepareChatUpload: async () => {
    const preparation = await chatUploadWorkflow.prepare();
    return {
      preparationId: preparation.preparationId,
      isFirstUpload: preparation.isFirstUpload,
      latestChatFilename: preparation.latestChatFilename,
      environment: preparation.environment,
      recoveryStatus: preparation.recoveryStatus
    };
  },
  onConfirmChatUpload: async (request, onProgress) => {
    const result = await chatUploadWorkflow.execute({ ...request, onProgress });
    await refreshPanelContext();
    if (!result.chatResult) {
      tavern.notify('角色卡備份失敗，為避免產生無法在遠端建立的聊天，本次未上傳聊天', 'warning');
      return { ...result, chat: null };
    }
    const upload = result.chatResult;
    const cloudPath = formatCloudPath(upload.path, upload.filename);
    const detail = upload.queued
      ? `已加入待傳佇列：${cloudPath}`
      : upload.cleanup === 'pending'
        ? `${cloudPath}（聊天已上傳；舊版本清理待重試）`
        : upload.metadata !== 'applied'
          ? `${cloudPath}（聊天已上傳；同步狀態延後更新）`
          : cloudPath;
    const environmentFailed = result.environmentResults.filter(item => item.status === 'error').length;
    if (upload.queued) {
      tavern.notify(`上傳未完成，已加入待傳佇列：${cloudPath}`, 'warning');
    } else if (result.status === 'partial') {
      tavern.notify(environmentFailed > 0 ? `聊天已上傳，${environmentFailed} 項環境備份失敗` : detail, 'warning');
    } else if (result.recoveryStatus === 'missing_character') {
      tavern.notify(`聊天已上傳，但雲端仍缺少角色卡：${cloudPath}`, 'warning');
    } else {
      tavern.notify(`目前聊天已上傳：${cloudPath}`, 'success');
    }
    return {
      status: result.status,
      environmentResults: result.environmentResults,
      recoveryStatus: result.recoveryStatus,
      chat: {
        status: upload.queued ? 'queued' : result.status === 'partial' ? 'partial' : 'done',
        detail
      }
    };
  },
  onBackupEnvironment: async (items, onProgress) => {
    const results = await environmentBackup.backupItems(items, { onProgress });
    const done = results.filter(result => result.status === 'done');
    const failed = results.filter(result => result.status === 'error');
    tavern.notify(
      failed.length === 0 ? `環境備份完成，共 ${done.length} 項` : `環境備份 ${done.length} 項完成，${failed.length} 項失敗`,
      failed.length === 0 ? 'success' : 'warning'
    );
    return results;
  },
  onRestoreEnvironment: async (items, onProgress) => {
    const result = await environmentRestore.restoreLatest(items, { onProgress });
    const done = result.items.filter(item => item.status === 'done');
    const failed = result.items.filter(item => item.status === 'error');
    const aborted = result.items.filter(item => item.status === 'aborted');
    const problems = failed.length + aborted.length;
    tavern.notify(
      problems === 0 ? `環境還原完成，共 ${done.length} 項` : `環境還原 ${done.length} 項完成，${problems} 項未套用`,
      problems === 0 ? 'success' : 'warning'
    );
    return result;
  },
  onPreviewRestore: async items => {
    const preview = Object.fromEntries(ENVIRONMENT_ITEM_KINDS.map(kind => [kind, null])) as Record<
      EnvironmentItemKind,
      string | null
    >;
    for (const kind of items) {
      const versions = await environmentBackup.listItemVersions(kind);
      preview[kind] = versions.at(-1)?.filename ?? null;
    }
    return preview;
  },
  onDownloadLatest: async () => {
    const result = await chatSync.downloadLatestAndReplace();
    await refreshPanelContext();
    const detail = result.status === 'done'
      ? `已更新為 ${result.filename}`
      : `聊天已更新為 ${result.filename}，但同步狀態尚待核對`;
    tavern.notify(
      result.status === 'done' ? '已使用雲端最新版更新目前聊天' : detail,
      result.status === 'done' ? 'success' : 'warning'
    );
    return { filename: result.filename, status: result.status, detail };
  },
  onListCloudRoles: () => listCloudRoles(driveService),
  onListCloudChats: roleKey => listCloudChats(driveService, roleKey),
  onPullChat: async (roleKey, chatId) => {
    const result = await chatPull.pullChat(roleKey, chatId);
    await refreshPanelContext();
    tavern.notify(
      result.characterRestored ? '已還原角色卡並建立聊天' : '已從雲端建立聊天',
      'success'
    );
    return result;
  },
  onListRestorePointChats: () => restorePoints.listChats(),
  onListRestorePointBatches: target => restorePoints.listChat(target),
  onPreviewRestorePointCleanup: (days, target) => restorePoints.previewCleanup(days, target),
  onTrashRestorePointFiles: async files => {
    const result = await restorePoints.trashFiles(files);
    tavern.notify(
      result.failed.length === 0
        ? `已將 ${result.affected} 個還原點檔案移到 Drive 垃圾桶`
        : `${result.affected} 個檔案已移到垃圾桶，${result.failed.length} 個失敗`,
      result.failed.length === 0 ? 'success' : 'warning'
    );
    return result;
  },
  onDeleteRestorePointFilesPermanently: async files => {
    const result = await restorePoints.deleteFilesPermanently(files);
    tavern.notify(
      result.failed.length === 0
        ? `已永久刪除 ${result.affected} 個還原點檔案`
        : `${result.affected} 個檔案已永久刪除，${result.failed.length} 個失敗`,
      result.failed.length === 0 ? 'success' : 'warning'
    );
    return result;
  }
});

const autoSync = new AutoSyncController({
  upload: async target => {
    try {
      await chatSync.uploadChat(target, { queueOnFail: true });
      await refreshPanelContext();
    } catch (error) {
      tavern.notify(error instanceof Error ? error.message : String(error), 'warning');
    }
  }
});

async function refreshPanelContext(): Promise<void> {
  const revision = ++panelRefreshRevision;
  const context = tavern.getContext();
  try {
    const meta = tavern.getChatMeta();
    const pendingUploads = countQueuedUploadsForChat(meta);
    let remoteCheckFailed = false;
    let localCheckFailed = false;
    const [remoteState, localContentHash] = await Promise.all([
      driveState.connected && meta
        ? chatSync.getRemoteVersionState(meta).catch(() => {
            remoteCheckFailed = true;
            return { latestFilename: null, baselineFound: false };
          })
        : Promise.resolve({ latestFilename: null, baselineFound: false }),
      meta
        ? chatSync.getCurrentContentHash().catch(() => {
            localCheckFailed = true;
            return null;
          })
        : Promise.resolve(null)
    ]);
    if (revision !== panelRefreshRevision) return;
    panel.updateContext(
      {
        ...context,
        status: computeSyncStatus({
          connected: driveState.connected,
          meta,
          remoteLatestFilename: remoteState.latestFilename,
          remoteBaselineFound: remoteState.baselineFound,
          localContentHash,
          remoteCheckFailed,
          localCheckFailed,
          pendingUploads,
          localMessageCount: context.lastMessageId === null ? 0 : context.lastMessageId + 1
        })
      },
      { lastSyncedVersion: meta?.last_synced_version ?? null, pendingUploads }
    );
  } catch {
    if (revision !== panelRefreshRevision) return;
    panel.updateContext(
      { ...context, status: driveState.connected ? 'check_failed' : 'not_connected' },
      { lastSyncedVersion: null, pendingUploads: 0 }
    );
  }
}

function markCurrentChatContentChanged(): void {
  try {
    const context = tavern.getContext();
    const meta = tavern.getChatMeta();
    panel.updateContext(
      {
        ...context,
        status: !driveState.connected
          ? 'not_connected'
          : meta?.last_synced_version
            ? 'local_dirty'
            : 'untracked'
      },
      {
        lastSyncedVersion: meta?.last_synced_version ?? null,
        pendingUploads: countQueuedUploadsForChat(meta)
      }
    );
  } catch {
    // 無法安全辨識目前聊天時，等待下一次完整刷新。
  }
}

async function applyPendingReceiptsAndRefresh(): Promise<void> {
  try {
    await chatSync.applyPendingReceiptsForCurrent();
  } catch {
    // 尚未載入聊天或 receipt 暫時無法核對時，仍刷新目前可取得的狀態。
  }
  await refreshPanelContext();
}

function boot(): void {
  (globalThis as Record<string, unknown>).__tavernRoamerBooted = true;
  console.info('[TavernRoamer] booting background services');
  removeLegacyScriptButton();
  ensureLauncherButton();
  void auth.preload().catch(() => undefined);
  void applyPendingReceiptsAndRefresh();
  panel.updateDriveStatus(driveState);
  const offChatChanged = tavern.onChatChanged(chatFileName => {
    markContextChanged();
    chatUploadWorkflow.invalidateAll();
    panel.invalidateUploadPreparation();
    tavern.getContext(chatFileName);
    void applyPendingReceiptsAndRefresh();
  });
  const offChatContentChanged = tavern.onChatContentChanged(markCurrentChatContentChanged);
  const offMessageCompleted = tavern.onMessageCompleted(() => {
    try {
      autoSync.handleMessageCompleted(chatSync.captureCurrentChat());
    } catch {
      // 沒有可辨識的目前聊天時不建立自動同步工作。
    }
  });

  window.addEventListener(
    'pagehide',
    () => {
      offChatChanged();
      offChatContentChanged();
      offMessageCompleted();
      autoSync.stop();
      if (launcherRetryId) window.clearTimeout(launcherRetryId);
      panel.unmount();
      getHostDocument().getElementById(LAUNCHER_ID)?.remove();
    },
    { once: true }
  );
}

function openPanel(): void {
  panel.mount({ floating: true });
  panel.updateDriveStatus(driveState);
  void refreshPanelContext();
}

function removeLegacyScriptButton(): void {
  const globals = globalThis as Record<string, any>;
  if (typeof globals.updateScriptButtonsWith !== 'function') {
    return;
  }
  try {
    const result = globals.updateScriptButtonsWith((buttons: Array<{ name?: string }>) =>
      buttons.filter(button => button.name !== LAUNCHER_LABEL)
    );
    if (result && typeof result.catch === 'function') {
      void result.catch(() => undefined);
    }
  } catch {
    // 舊版酒館助手沒有可用的腳本按鈕更新 API 時，保持魔法棒入口即可。
  }
}

function ensureLauncherButton(): void {
  const hostDocument = getHostDocument();
  const menu = hostDocument.querySelector('#extensionsMenu');
  if (!menu) {
    launcherRetryId = window.setTimeout(ensureLauncherButton, LAUNCHER_RETRY_MS);
    return;
  }
  launcherRetryId = null;
  if (hostDocument.getElementById(LAUNCHER_ID)) {
    return;
  }

  const launcher = hostDocument.createElement('div');
  launcher.id = LAUNCHER_ID;
  launcher.className = 'interactable';
  launcher.tabIndex = 0;
  launcher.setAttribute('role', 'button');
  launcher.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>${LAUNCHER_LABEL}</span>`;
  launcher.addEventListener('click', openPanel);
  launcher.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPanel();
    }
  });
  menu.append(launcher);
  console.info('[TavernRoamer] launcher added to the magic-wand menu');
}

function getHostDocument(): Document {
  try {
    return globalThis.parent?.document ?? document;
  } catch {
    return document;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export {};

function formatCloudPath(path: readonly string[], filename: string): string {
  return [...path, filename].join(' / ');
}

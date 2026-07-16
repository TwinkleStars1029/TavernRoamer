import { GoogleIdentityAuth } from './auth/GoogleIdentityAuth';
import { AutoSyncController } from './chat/AutoSyncController';
import { ChatSyncService } from './chat/ChatSyncService';
import { ChatPullService } from './chat/ChatPullService';
import { listCloudChats, listCloudRoles } from './chat/browse';
import { loadUploadQueue } from './chat/queue';
import { computeSyncStatus } from './chat/status';
import { GoogleDriveClient } from './drive/GoogleDriveClient';
import { DriveService } from './drive/DriveService';
import { EnvironmentBackupService } from './environment/EnvironmentBackupService';
import { EnvironmentRestoreService } from './environment/EnvironmentRestoreService';
import { ENVIRONMENT_ITEM_KINDS, type EnvironmentItemKind } from './environment/types';
import {
  registerApiSpikeSelfChecks,
  registerChatSelfChecks,
  registerDriveSelfChecks,
  registerPhase0SelfChecks,
  registerPullSelfChecks,
  registerUiSelfChecks
} from './selfCheck';
import { loadSettings } from './settings';
import { createTavernApi, createTavernPullAdapter } from './tavern';
import type { DriveConnectionState } from './types';
import { createPanel } from './ui';

registerPhase0SelfChecks();
registerApiSpikeSelfChecks();
registerChatSelfChecks();
registerPullSelfChecks();

const tavern = createTavernApi();
const auth = new GoogleIdentityAuth(() => loadSettings().googleClientId);
const driveClient = new GoogleDriveClient({ tokenProvider: auth });
const driveService = new DriveService(driveClient);
const adapter = tavern.getChatAdapter();
const chatSync = new ChatSyncService(adapter, driveService);
const environmentBackup = new EnvironmentBackupService(adapter, driveService);
const environmentRestore = new EnvironmentRestoreService(adapter, driveService);
const chatPull = new ChatPullService(createTavernPullAdapter(), driveService);
let driveState: DriveConnectionState = { connected: false, email: null, error: null };

registerDriveSelfChecks(driveService, () => driveState.connected);

const panel = createPanel({
  getContext: () => tavern.getContext(),
  getDriveState: () => driveState,
  onSave: settings => tavern.notify(`裝置名稱已儲存：${settings.deviceName}`, 'success'),
  onConnectDrive: async () => {
    await auth.connect();
    const email = await driveClient.getAccountEmail();
    driveState = { connected: true, email, error: null };
    await chatSync.flushQueue();
    await refreshPanelContext();
    return driveState;
  },
  onManualUpload: async () => {
    const result = await chatSync.uploadCurrentChat({ queueOnFail: true });
    await chatSync.flushQueue();
    await refreshPanelContext();
    tavern.notify(result.queued ? '上傳失敗，已加入待傳佇列' : '目前聊天已上傳', result.queued ? 'warning' : 'success');
    return result.filename;
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
    const preview = Object.fromEntries(ENVIRONMENT_ITEM_KINDS.map(kind => [kind, false])) as Record<
      EnvironmentItemKind,
      boolean
    >;
    for (const kind of items) {
      try {
        const versions = await environmentBackup.listItemVersions(kind);
        preview[kind] = versions.length > 0;
      } catch {
        preview[kind] = false;
      }
    }
    return preview;
  },
  onDownloadLatest: async () => {
    const filename = await chatSync.downloadLatestAndReplace();
    await refreshPanelContext();
    tavern.notify('已下載並覆蓋目前聊天', 'success');
    return filename;
  },
  onListCloudRoles: () => listCloudRoles(driveService),
  onListCloudChats: roleKey => listCloudChats(driveService, roleKey),
  onPullChat: async (roleKey, chatId) => {
    const result = await chatPull.pullChat(roleKey, chatId);
    await refreshPanelContext();
    tavern.notify(
      result.characterRestored ? '已還原角色卡並拉取聊天' : '已從雲端拉取聊天',
      'success'
    );
    return result;
  }
});

registerUiSelfChecks(() => panel.probe());

const autoSync = new AutoSyncController({
  upload: async () => {
    try {
      await chatSync.uploadCurrentChat({ queueOnFail: true });
      await refreshPanelContext();
    } catch (error) {
      tavern.notify(error instanceof Error ? error.message : String(error), 'warning');
    }
  }
});

async function refreshPanelContext(): Promise<void> {
  const context = tavern.getContext();
  const pendingUploads = loadUploadQueue().length;
  try {
    const meta = tavern.getChatMeta();
    const remoteLatestFilename = driveState.connected && meta ? await chatSync.getLatestRemoteFilename(meta) : null;
    panel.updateContext(
      {
        ...context,
        status: computeSyncStatus({
          connected: driveState.connected,
          meta,
          remoteLatestFilename,
          localMessageCount: context.lastMessageId === null ? 0 : context.lastMessageId + 1
        })
      },
      { lastSyncedVersion: meta?.last_synced_version ?? null, pendingUploads }
    );
  } catch {
    panel.updateContext(context, { lastSyncedVersion: null, pendingUploads });
  }
}

function boot(): void {
  (globalThis as Record<string, unknown>).__tavernRoamerBooted = true;
  console.info('[TavernRoamer] booting panel');
  panel.mount();
  void auth.preload().catch(() => undefined);
  void refreshPanelContext();
  panel.updateDriveStatus(driveState);
  tavern.onChatChanged(chatFileName => {
    tavern.getContext(chatFileName);
    void refreshPanelContext();
  });
  tavern.onMessageCompleted(() => autoSync.handleMessageCompleted());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export {};

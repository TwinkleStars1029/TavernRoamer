// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanel } from '../src/ui';
import type { PanelController, PanelOptions } from '../src/ui';
import { getFocusableElements } from '../src/ui/panelHost';
import type {
  ChatUploadPreparationView,
  ChatUploadWorkflowViewResult,
  EnvironmentBackupViewResult
} from '../src/ui/types';
import type { RestorePointBatch, RestorePointChatSummary, RestorePointCleanupPreview } from '../src/restorePoints/types';
import type { DriveConnectionState, Settings, SyncStatus, TavernContext } from '../src/types';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 永遠不會完成的 promise，模擬仍在進行中的操作。 */
const never = () => new Promise<never>(() => undefined);

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const flushFocus = async () => {
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
  await flush();
};

const settings: Settings = {
  deviceName: '測試電腦',
  googleClientId: 'client-id',
  autoSyncEnabled: true,
  autoSyncEveryN: 3,
  chatRetention: { mode: 'keep_latest_n', latestN: 10 }
};

const connected: DriveConnectionState = { connected: true, email: 'user@example.com', error: null };

function contextFor(status: SyncStatus, hasChat = true): TavernContext {
  return {
    characterName: hasChat ? 'Sasuke' : null,
    characterId: hasChat ? '1' : null,
    chatFileName: hasChat ? 'chat.jsonl' : null,
    chatId: hasChat ? 'chat-1' : null,
    lastMessageId: hasChat ? 7 : null,
    status
  };
}

function buildOptions(overrides: Partial<PanelOptions> = {}): PanelOptions {
  return {
    getContext: () => contextFor('local_dirty'),
    getDriveState: () => connected,
    getSettings: () => settings,
    saveSettings: next => next,
    onSave: vi.fn(),
    onConnectDrive: vi.fn(async () => connected),
    onPrepareChatUpload: vi.fn(() => never()),
    onConfirmChatUpload: vi.fn(() => never()),
    onBackupEnvironment: vi.fn(() => never()),
    onRestoreEnvironment: vi.fn(() => never()),
    onPreviewRestore: vi.fn(() => never()),
    onDownloadLatest: vi.fn(() => never()),
    onListCloudRoles: vi.fn(async () => []),
    onListCloudChats: vi.fn(async () => []),
    onPullChat: vi.fn(() => never()),
    onListRestorePointChats: vi.fn(async () => []),
    onListRestorePointBatches: vi.fn(async () => []),
    onPreviewRestorePointCleanup: vi.fn(() => never()),
    onTrashRestorePointFiles: vi.fn(async () => ({ requested: 0, affected: 0, failed: [] })),
    onDeleteRestorePointFilesPermanently: vi.fn(async () => ({ requested: 0, affected: 0, failed: [] })),
    onRunSelfChecks: vi.fn(async () => []),
    onRefreshStatus: vi.fn(async () => undefined),
    onFlushQueue: vi.fn(async () => ({ uploaded: 0, remaining: 0 })),
    ...overrides
  };
}

let panel: PanelController | null = null;

function mountPanel(options: PanelOptions): HTMLElement {
  panel = createPanel(options);
  panel.mount({ floating: true });
  const root = document.querySelector<HTMLElement>('#tavern-roamer-panel');
  if (!root) throw new Error('panel did not mount');
  return root;
}

function $(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function buttons(root: HTMLElement, selector: string): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(selector)];
}

function progressLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-field="progress"] .tr-row-label')].map(label => label.textContent ?? '');
}

function backupDone(kinds: EnvironmentBackupViewResult['kind'][]): EnvironmentBackupViewResult[] {
  return kinds.map(kind => ({ kind, status: 'done', filename: `${kind}.json` }));
}

beforeEach(() => {
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    value: vi.fn(() => true)
  });
});

afterEach(() => {
  panel?.unmount();
  panel = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'confirm');
});

describe('createPanel dialog keyboard behavior', () => {
  it('focuses the active screen heading after opening and navigation', async () => {
    const root = mountPanel(buildOptions());
    await flushFocus();

    expect(document.activeElement).toBe($(root, '[data-screen="home"] h2'));

    $(root, '[data-navigate="settings"]').click();
    await flushFocus();

    expect(document.activeElement).toBe($(root, '[data-screen="settings"] h2'));
  });

  it('closes once on Escape, removes the listener, and restores the opener focus', async () => {
    const opener = document.createElement('button');
    opener.textContent = '開啟面板';
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    mountPanel(buildOptions({ onClose }));
    await flushFocus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(document.querySelector('#tavern-roamer-panel')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onClose).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab in the dialog and excludes hidden or disabled controls', async () => {
    const background = document.createElement('button');
    background.textContent = '背景控制';
    document.body.append(background);
    const root = mountPanel(buildOptions());
    await flushFocus();
    const dialog = $(root, '.tr-modal');
    const hiddenControl = $(root, '[data-screen="upload-confirm"] [data-action="manual-upload"]');
    const disabledControl = $(root, '[data-screen="home"] [data-home-task]') as HTMLButtonElement;
    disabledControl.disabled = true;

    const focusable = getFocusableElements(dialog);
    expect(focusable).not.toContain(hiddenControl);
    expect(focusable).not.toContain(disabledControl);
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable.at(-1)!;

    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    }));
    expect(document.activeElement).toBe(last);

    background.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
  });
});

describe('createPanel progress lock', () => {
  it('locks home tasks while an operation runs, refuses a second operation, and unlocks afterwards', async () => {
    const backup = deferred<EnvironmentBackupViewResult[]>();
    const options = buildOptions({ onBackupEnvironment: vi.fn(() => backup.promise) });
    const root = mountPanel(options);

    $(root, '[data-action="backup-environment"]').click();
    await flush();

    const homeTasks = buttons(root, '[data-screen="home"] [data-home-task]');
    expect(homeTasks.length).toBeGreaterThan(0);
    expect(homeTasks.every(button => button.disabled)).toBe(true);
    expect(($(root, '[data-field="home-current-primary"]') as HTMLButtonElement).disabled).toBe(true);
    expect($(root, '[data-field="home-progress-lock"]').hidden).toBe(false);
    expect(($(root, '[data-action="confirm-cloud-pull"]') as HTMLButtonElement).disabled).toBe(true);
    expect(($(root, '[data-action="download-latest"]') as HTMLButtonElement).disabled).toBe(true);
    const rowsBefore = progressLabels(root);
    expect(rowsBefore).toEqual(['角色卡', '世界書', 'Persona', 'Preset', 'Regex']);

    // 預覽還原不在進度鎖的停用名單中，可以點擊，但不得開始新操作或洗掉進度。
    $(root, '[data-action="restore-environment"]').click();
    await flush();

    expect(options.onPreviewRestore).not.toHaveBeenCalled();
    expect(progressLabels(root)).toEqual(rowsBefore);
    expect($(root, '[data-field="report"]').textContent).toBe('目前操作完成後，才能開始新的操作。');

    backup.resolve(backupDone(['character', 'world', 'persona', 'preset', 'regex']));
    await flush();

    expect(buttons(root, '[data-screen="home"] [data-home-task]').every(button => !button.disabled)).toBe(true);
    expect($(root, '[data-field="home-progress-lock"]').hidden).toBe(true);
    expect(($(root, '[data-action="confirm-cloud-pull"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('retries a failed environment row inside an upload without wiping the chat row', async () => {
    const retryBackup = deferred<EnvironmentBackupViewResult[]>();
    const onBackupEnvironment = vi.fn(() => retryBackup.promise);
    const options = buildOptions({
      onPrepareChatUpload: vi.fn(async (): Promise<ChatUploadPreparationView> => ({
        preparationId: 'prep-1',
        isFirstUpload: false,
        latestChatFilename: 'chat__old.jsonl',
        environment: [
          { kind: 'character', available: false, latestFilename: null },
          { kind: 'world', available: false, latestFilename: null }
        ],
        recoveryStatus: 'missing_character'
      })),
      onConfirmChatUpload: vi.fn(async (_input, onProgress): Promise<ChatUploadWorkflowViewResult> => {
        onProgress({ kind: 'world', step: 'upload', state: 'error', error: 'boom' });
        return {
          status: 'partial',
          environmentResults: [
            { kind: 'character', status: 'done', filename: 'character.json' },
            { kind: 'world', status: 'error', error: 'boom' }
          ],
          chat: { status: 'done', detail: '已上傳' },
          recoveryStatus: 'ready'
        };
      }),
      onBackupEnvironment
    });
    const root = mountPanel(options);

    $(root, '[data-field="home-current-primary"]').click();
    await flush();
    $(root, '[data-action="upload-with-environment"]').click();
    await flush();

    expect(options.onConfirmChatUpload).toHaveBeenCalledWith(
      expect.objectContaining({ selectedEnvironment: ['character', 'world'], chatOnly: false }),
      expect.any(Function)
    );
    expect(progressLabels(root)).toEqual(['角色卡', '世界書', '目前聊天']);

    $(root, '[data-retry-key="world"]').click();
    await flush();

    expect(onBackupEnvironment).toHaveBeenCalledTimes(1);
    expect(onBackupEnvironment).toHaveBeenCalledWith(['world'], expect.any(Function));
    expect(progressLabels(root)).toEqual(['角色卡', '世界書', '目前聊天']);
    expect($(root, '[data-field="home-progress-lock"]').hidden).toBe(false);

    retryBackup.resolve(backupDone(['world']));
    await flush();

    expect(progressLabels(root)).toEqual(['角色卡', '世界書', '目前聊天']);
    expect(root.querySelector('[data-retry-key="world"]')).toBeNull();
    expect($(root, '[data-field="home-progress-lock"]').hidden).toBe(true);
  });
});

describe('createPanel restore-point guards', () => {
  const chatSummary: RestorePointChatSummary = {
    key: 'sasuke/chat-1',
    roleKey: 'sasuke',
    chatId: 'chat-1',
    batchCount: 1,
    latestCreatedAt: '2026-01-01T00:00:00.000Z',
    restoreRootCount: 1,
    duplicatePath: false
  };

  const restorePointBatch: RestorePointBatch = {
    roleKey: 'sasuke',
    chatId: 'chat-1',
    folderId: 'batch-folder-1',
    name: '2026-01-01_080000',
    createdAt: '2026-01-01T00:00:00.000Z',
    files: [{
      roleKey: 'sasuke',
      chatId: 'chat-1',
      fileId: 'restore-file-1',
      filename: 'chat.jsonl',
      kind: 'chat',
      relativePath: 'chat.jsonl',
      batchFolderId: 'batch-folder-1',
      batchName: '2026-01-01_080000',
      uploadedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }],
    emptyFolders: [],
    issues: []
  };

  it('keeps restore-point controls disabled while loading even when the chat context updates', async () => {
    const chats = deferred<RestorePointChatSummary[]>();
    const root = mountPanel(buildOptions({ onListRestorePointChats: vi.fn(() => chats.promise) }));

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();

    const ageButtons = buttons(root, '[data-restore-age]');
    const selectionButtons = buttons(
      root,
      '[data-action="trash-selected-restore-points"], [data-action="delete-selected-restore-points-permanently"]'
    );
    expect(ageButtons.length).toBe(4);
    expect(ageButtons.every(button => button.disabled)).toBe(true);

    panel!.updateContext(contextFor('newer_remote'));

    expect(ageButtons.every(button => button.disabled)).toBe(true);
    expect(($(root, '[data-action="refresh-restore-points"]') as HTMLButtonElement).disabled).toBe(true);
    expect(selectionButtons.every(button => button.disabled)).toBe(true);

    chats.resolve([chatSummary]);
    await flush();

    expect(ageButtons.every(button => !button.disabled)).toBe(true);
    panel!.updateContext(contextFor('local_dirty'));
    expect(selectionButtons.every(button => button.disabled)).toBe(true);
  });

  it('blocks a second cleanup while a cleanup scan is running', async () => {
    const scan = deferred<RestorePointCleanupPreview>();
    const options = buildOptions({ onPreviewRestorePointCleanup: vi.fn(() => scan.promise) });
    const root = mountPanel(options);

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();
    $(root, '[data-restore-age="15"][data-restore-scope="all"]').click();
    await flush();

    panel!.updateContext(contextFor('synced'));

    const ageButtons = buttons(root, '[data-restore-age]');
    expect(ageButtons.every(button => button.disabled)).toBe(true);
    $(root, '[data-restore-age="30"][data-restore-scope="all"]').click();
    expect(options.onPreviewRestorePointCleanup).toHaveBeenCalledTimes(1);

    scan.resolve({ days: 15, scope: 'all', targets: [], roleCount: 0, chatCount: 0, batchCount: 0 });
    await flush();

    expect(ageButtons.every(button => !button.disabled)).toBe(true);
    expect($(root, '[data-field="restore-point-feedback"]').textContent).toContain('沒有放入 _pre_restore 超過 15 天的檔案');
  });

  it('keeps cleanup locked across navigation and a completed chat-list reload', async () => {
    const scan = deferred<RestorePointCleanupPreview>();
    const options = buildOptions({
      onListRestorePointChats: vi.fn(async () => [chatSummary]),
      onPreviewRestorePointCleanup: vi.fn(() => scan.promise)
    });
    const root = mountPanel(options);

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();
    $(root, '[data-restore-age="15"][data-restore-scope="all"]').click();
    await flush();

    $(root, '[data-screen="restore-points"] [data-navigate="home"]').click();
    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();

    const ageButtons = buttons(root, '[data-restore-age]');
    expect(ageButtons.every(button => button.disabled)).toBe(true);
    const secondCleanup = $(root, '[data-restore-age="30"][data-restore-scope="all"]') as HTMLButtonElement;
    secondCleanup.disabled = false;
    secondCleanup.click();
    expect(options.onPreviewRestorePointCleanup).toHaveBeenCalledTimes(1);

    scan.resolve({ days: 15, scope: 'all', targets: [], roleCount: 0, chatCount: 0, batchCount: 0 });
    await flush();

    expect(ageButtons.every(button => !button.disabled)).toBe(true);
  });

  it('keeps destructive selection actions locked across navigation and reload', async () => {
    const mutation = deferred<{ requested: number; affected: number; failed: Array<{ fileId: string; error: string }> }>();
    const options = buildOptions({
      onListRestorePointChats: vi.fn(async () => [chatSummary]),
      onListRestorePointBatches: vi.fn(async () => [restorePointBatch]),
      onTrashRestorePointFiles: vi.fn(() => mutation.promise)
    });
    const root = mountPanel(options);

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();
    $(root, '[data-restore-chat]').click();
    await flush();
    ($(root, '[data-restore-file]') as HTMLInputElement).click();
    $(root, '[data-action="trash-selected-restore-points"]').click();
    await flush();

    $(root, '[data-screen="restore-points"] [data-navigate="home"]').click();
    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();

    const trash = $(root, '[data-action="trash-selected-restore-points"]') as HTMLButtonElement;
    const permanentlyDelete = $(root, '[data-action="delete-selected-restore-points-permanently"]') as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    expect(permanentlyDelete.disabled).toBe(true);
    trash.disabled = false;
    trash.click();
    expect(options.onTrashRestorePointFiles).toHaveBeenCalledTimes(1);

    mutation.resolve({ requested: 1, affected: 0, failed: [{ fileId: 'restore-file-1', error: 'still present' }] });
    await flush();

    expect(trash.disabled).toBe(false);
    expect(permanentlyDelete.disabled).toBe(false);
  });

  it('recomputes every restore-point list control when Drive connectivity changes', async () => {
    const chats = deferred<RestorePointChatSummary[]>();
    const options = buildOptions({
      onListRestorePointChats: vi.fn(() => chats.promise),
      onListRestorePointBatches: vi.fn(async () => [restorePointBatch])
    });
    const root = mountPanel(options);

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();
    panel!.updateDriveStatus({ connected: false, email: null, error: 'expired' });
    chats.resolve([chatSummary]);
    await flush();
    panel!.updateDriveStatus(connected);

    const search = $(root, '[data-field="restore-search"]') as HTMLInputElement;
    const sort = $(root, '[data-field="restore-sort"]') as HTMLSelectElement;
    const chat = $(root, '[data-restore-chat]') as HTMLButtonElement;
    const back = $(root, '[data-action="back-to-restore-chats"]') as HTMLButtonElement;
    expect([search, sort, chat, back].every(control => !control.disabled)).toBe(true);

    chat.click();
    await flush();
    const selectAll = $(root, '[data-action="select-all-restore-points"]') as HTMLInputElement;
    expect(selectAll.disabled).toBe(false);

    panel!.updateDriveStatus({ connected: false, email: null, error: 'expired' });

    expect([search, sort, chat, back, selectAll].every(control => control.disabled)).toBe(true);
  });

  it('does not lock restore-point management while a progress operation runs', async () => {
    const root = mountPanel(buildOptions());

    $(root, '[data-screen="home"] [data-navigate="restore-points"]').click();
    await flush();
    $(root, '[data-action="backup-environment"]').click();
    await flush();

    expect($(root, '[data-field="home-progress-lock"]').hidden).toBe(false);
    expect(buttons(root, '[data-restore-age]').every(button => !button.disabled)).toBe(true);
    expect(($(root, '[data-action="refresh-restore-points"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('createPanel home status card', () => {
  it('recomputes the primary next step on updateContext while keeping the live region node', () => {
    const root = mountPanel(buildOptions());
    const status = $(root, '.tr-current-status');
    const home = () => $(root, '[data-screen="home"]');
    const primary = () => root.querySelector<HTMLButtonElement>('[data-field="home-current-primary"]');

    expect(primary()?.dataset.navigate).toBe('upload-confirm');
    expect(primary()?.textContent).toContain('上傳目前聊天');

    panel!.updateContext(contextFor('newer_remote'), { lastSyncedVersion: null, pendingUploads: 2 });
    expect(primary()?.dataset.navigate).toBe('download-confirm');
    expect(primary()?.textContent).toContain('用雲端版更新');
    expect(home().textContent).toContain('更新前會先建立還原點');
    expect(home().querySelectorAll('.tr-primary')).toHaveLength(1);
    expect($(root, '[data-field="queue"]').textContent).toBe('待傳 2 筆');
    expect($(root, '.tr-current-status [data-field="status"]').textContent).toBe('雲端有新版');

    panel!.updateContext(contextFor('synced'), { lastSyncedVersion: null, pendingUploads: 0 });
    expect(primary()).toBeNull();
    expect(home().querySelectorAll('.tr-primary')).toHaveLength(0);
    expect(root.querySelector('[data-field="queue-segment"]')).toBeNull();

    panel!.updateContext(contextFor('unknown', false));
    expect(primary()).toBeNull();
    expect(home().textContent).toContain('請先在酒館開啟一段聊天');

    panel!.updateContext(contextFor('local_dirty'));
    expect(primary()?.dataset.navigate).toBe('upload-confirm');
    expect(home().querySelectorAll('.tr-primary')).toHaveLength(1);
    expect($(root, '.tr-current-status')).toBe(status);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.isConnected).toBe(true);
  });

  it('keeps 前往連線 usable when Drive disconnects during a running operation', async () => {
    const root = mountPanel(buildOptions());

    $(root, '[data-action="backup-environment"]').click();
    await flush();
    panel!.updateDriveStatus({ connected: false, email: null, error: 'expired' });
    panel!.updateContext(contextFor('local_dirty'));

    const connect = $(root, '[data-field="home-connect-primary"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    expect(connect.classList.contains('tr-disabled')).toBe(false);
    expect($(root, '[data-field="home-disconnected"]').hidden).toBe(false);
    expect($(root, '[data-field="home-actions"]').hidden).toBe(true);
    expect($(root, '[data-field="home-current"]').hidden).toBe(true);
    expect(buttons(root, '[data-drive-required]').every(button => button.disabled)).toBe(true);

    connect.click();
    expect($(root, '[data-screen="settings"]').hidden).toBe(false);
  });

  it('switches the call to action across statuses and toggles the conflict callout', () => {
    const root = mountPanel(buildOptions());
    const status = $(root, '.tr-current-status');
    const primary = () => root.querySelector<HTMLButtonElement>('[data-field="home-current-primary"]');
    const conflictWarning = () => $(root, '[data-field="download-conflict-warning"]');

    panel!.updateContext(contextFor('untracked'));
    expect(primary()?.dataset.navigate).toBe('upload-confirm');
    expect($(root, '[data-field="home-current-cta"]').textContent).toContain('第一次上傳會建立雲端版本');

    panel!.updateContext(contextFor('remote_missing'));
    expect(primary()?.textContent).toContain('重新上傳');
    expect(primary()?.dataset.navigate).toBe('upload-confirm');

    panel!.updateContext(contextFor('check_failed'));
    expect(primary()?.dataset.action).toBe('refresh-status');
    expect(primary()?.textContent).toContain('重新檢查');
    expect(conflictWarning().hidden).toBe(true);

    panel!.updateContext(contextFor('conflict'));
    expect(primary()).toBeNull();
    expect($(root, '[data-screen="home"]').querySelectorAll('.tr-primary')).toHaveLength(0);
    expect(($(root, '[data-field="home-current-conflict-upload"]') as HTMLButtonElement).dataset.navigate).toBe('upload-confirm');
    expect(($(root, '[data-field="home-current-conflict-download"]') as HTMLButtonElement).dataset.navigate).toBe('download-confirm');
    expect(conflictWarning().hidden).toBe(false);

    $(root, '[data-field="home-current-conflict-download"]').click();
    expect($(root, '[data-screen="download-confirm"]').hidden).toBe(false);
    expect(conflictWarning().textContent).toContain('本機有尚未上傳的變更，更新後只能從雲端還原點找回。');

    panel!.updateContext(contextFor('newer_remote'));
    expect(conflictWarning().hidden).toBe(true);
    expect($(root, '.tr-current-status')).toBe(status);
  });

  it('locks the conflict choices while a progress operation runs', async () => {
    const root = mountPanel(buildOptions({ getContext: () => contextFor('conflict') }));

    $(root, '[data-action="backup-environment"]').click();
    await flush();
    panel!.updateContext(contextFor('conflict'));

    expect(buttons(root, '[data-field^="home-current-conflict-"]')).toHaveLength(2);
    expect(buttons(root, '[data-field^="home-current-conflict-"]').every(button => button.disabled)).toBe(true);
  });

  it('runs 重新檢查 once while pending and shows a busy state', async () => {
    const refresh = deferred<void>();
    const options = buildOptions({
      getContext: () => contextFor('unknown'),
      onRefreshStatus: vi.fn(() => refresh.promise)
    });
    const root = mountPanel(options);
    const primary = () => $(root, '[data-field="home-current-primary"]') as HTMLButtonElement;

    expect(primary().textContent).toContain('重新檢查');
    primary().click();
    await flush();

    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toContain('檢查中…');
    primary().disabled = false;
    primary().click();
    // 刷新途中 updateContext 重繪狀態卡，仍保持忙碌狀態。
    panel!.updateContext(contextFor('check_failed'));
    expect(primary().textContent).toContain('檢查中…');
    expect(primary().disabled).toBe(true);
    expect(options.onRefreshStatus).toHaveBeenCalledTimes(1);

    refresh.resolve();
    await flush();

    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toContain('重新檢查');
    expect(primary().textContent).not.toContain('檢查中…');
  });

  it('shows a short message when 重新檢查 fails', async () => {
    const root = mountPanel(buildOptions({
      getContext: () => contextFor('check_failed'),
      onRefreshStatus: vi.fn(async () => { throw new Error('網路中斷'); })
    }));

    $(root, '[data-field="home-current-primary"]').click();
    await flush();

    expect($(root, '[data-field="home-current-feedback"]').textContent).toBe('重新檢查失敗：網路中斷');
    expect(($(root, '[data-field="home-current-primary"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('flushes the queue once on double click, reports the result, and hides the button when nothing is pending', async () => {
    const flushResult = deferred<{ uploaded: number; remaining: number }>();
    const options = buildOptions({ onFlushQueue: vi.fn(() => flushResult.promise) });
    const root = mountPanel(options);
    const status = $(root, '.tr-current-status');
    const flushButton = () => root.querySelector<HTMLButtonElement>('[data-action="flush-queue"]');

    expect(flushButton()).toBeNull();
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 3 });
    expect(flushButton()?.textContent).toContain('立即補傳');
    expect(flushButton()?.disabled).toBe(false);

    flushButton()!.click();
    await flush();
    expect(flushButton()?.disabled).toBe(true);
    expect(flushButton()?.textContent).toContain('補傳中…');
    flushButton()!.disabled = false;
    flushButton()!.click();
    expect(options.onFlushQueue).toHaveBeenCalledTimes(1);

    // index.ts 的 refreshPanelContext 會在補傳後回報新的待傳筆數。
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 1 });
    expect(flushButton()?.textContent).toContain('補傳中…');
    flushResult.resolve({ uploaded: 2, remaining: 1 });
    await flush();

    const feedback = $(root, '[data-field="home-current-feedback"]');
    expect(feedback.textContent).toBe('已補傳 2 筆，還有 1 筆未完成');
    expect(status.contains(feedback)).toBe(true);
    expect(flushButton()?.disabled).toBe(false);
    expect(flushButton()?.textContent).toContain('立即補傳');
    expect($(root, '[data-field="queue"]').textContent).toBe('待傳 1 筆');

    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 0 });
    expect(flushButton()).toBeNull();
    expect($(root, '.tr-current-status')).toBe(status);
  });

  it('reports a full flush without a remaining count', async () => {
    const root = mountPanel(buildOptions({ onFlushQueue: vi.fn(async () => ({ uploaded: 2, remaining: 0 })) }));
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 2 });

    $(root, '[data-action="flush-queue"]').click();
    await flush();

    expect($(root, '[data-field="home-current-feedback"]').textContent).toBe('已補傳 2 筆');
  });

  it('shows the failure text when 立即補傳 fails', async () => {
    const root = mountPanel(buildOptions({ onFlushQueue: vi.fn(async () => { throw new Error('配額不足'); }) }));
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 1 });

    $(root, '[data-action="flush-queue"]').click();
    await flush();

    expect($(root, '[data-field="home-current-feedback"]').textContent).toBe('補傳失敗：配額不足');
    expect(($(root, '[data-action="flush-queue"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables 立即補傳 while a progress operation runs or Drive is disconnected', async () => {
    const options = buildOptions();
    const root = mountPanel(options);
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 2 });

    $(root, '[data-action="backup-environment"]').click();
    await flush();
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 2 });

    const flushButton = $(root, '[data-action="flush-queue"]') as HTMLButtonElement;
    expect(flushButton.disabled).toBe(true);
    flushButton.click();
    expect(options.onFlushQueue).not.toHaveBeenCalled();

    panel!.unmount();
    const idleRoot = mountPanel(options);
    panel!.updateContext(contextFor('local_dirty'), { lastSyncedVersion: null, pendingUploads: 2 });
    panel!.updateDriveStatus({ connected: false, email: null, error: 'expired' });
    expect(($(idleRoot, '[data-action="flush-queue"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

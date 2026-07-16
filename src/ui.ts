import type { EnvironmentBackupResult } from './environment/EnvironmentBackupService';
import type { EnvironmentRestoreResult } from './environment/EnvironmentRestoreService';
import type { EnvironmentItemKind, EnvironmentProgressEvent } from './environment/types';
import { formatLastSyncedLabel } from './drive/version';
import { loadSettings, saveSettings } from './settings';
import { runSelfChecks } from './selfCheck';
import type { DriveConnectionState, PanelStatusInfo, Settings, SyncStatus, TavernContext } from './types';
import type { CloudChatEntry, CloudRoleEntry } from './chat/browse';
import type { PullResult } from './chat/ChatPullService';

const BACKUP_ITEM_LABELS: Record<EnvironmentItemKind, string> = {
  character: '角色卡',
  world: '世界書',
  persona: 'Persona',
  preset: 'Preset',
  regex: 'Regex'
};

const DEFAULT_BACKUP_ITEMS: EnvironmentItemKind[] = ['character', 'world', 'persona', 'preset', 'regex'];

// 未連線 Drive 時需 disable 的操作按鈕（手冊 14.4 防呆）
const DRIVE_GUARDED_ACTIONS = [
  'manual-upload',
  'download-latest',
  'backup-environment',
  'restore-environment',
  'browse-cloud'
] as const;
const DRIVE_GUARD_TITLE = '請先連線 Google Drive';

// ── 純函式（可單元測試）─────────────────────────────────────────────

export type PillTone = 'green' | 'yellow' | 'orange' | 'grey';

/** 狀態 → 色點 pill 文案與色調（手冊 14.3）。 */
export function statusPill(status: SyncStatus): { label: string; tone: PillTone } {
  switch (status) {
    case 'synced':
      return { label: '已是最新', tone: 'green' };
    case 'newer_remote':
      return { label: '雲端有新版', tone: 'yellow' };
    case 'local_dirty':
      return { label: '本地有未上傳變更', tone: 'orange' };
    case 'not_connected':
      return { label: '未連線', tone: 'grey' };
    default:
      return { label: '未知', tone: 'grey' };
  }
}

/** 待傳佇列文案（手冊 14.3）：>0 顯示「待傳 N 筆」警示，=0 顯示正常色的「無」。 */
export function formatPendingLabel(count: number): { text: string; visible: boolean; tone: 'warn' | 'normal' } {
  if (!Number.isFinite(count) || count <= 0) {
    return { text: '無', visible: false, tone: 'normal' };
  }
  return { text: `待傳 ${Math.floor(count)} 筆`, visible: true, tone: 'warn' };
}

/** 自動同步文案（手冊 14.3）。 */
export function formatAutoSyncLabel(settings: Pick<Settings, 'autoSyncEnabled' | 'autoSyncEveryN'>): string {
  return settings.autoSyncEnabled ? `每 ${settings.autoSyncEveryN} 則` : '已停用';
}

/** 進度清單頂部 n/m 計數（n = 已結束項數）。 */
export function progressRatioLabel(settled: number, total: number): string {
  return `${settled}/${total}`;
}

// ── 面板控制器 ─────────────────────────────────────────────────────

export type PanelHealth = {
  mounted: boolean;
  hasInlineDrawer: boolean;
  toggleReady: boolean;
  details: Record<string, unknown>;
};

export type PanelController = {
  mount: () => void;
  updateContext: (context: TavernContext, info?: PanelStatusInfo) => void;
  updateDriveStatus: (state: DriveConnectionState) => void;
  probe: () => PanelHealth;
};

type ProgressOp = 'backup' | 'restore' | 'upload' | 'download' | 'pull';
type ProgressRowState = 'pending' | 'active' | 'done' | 'error' | 'aborted' | 'skipped';
type ProgressRow = {
  key: string;
  label: string;
  state: ProgressRowState;
  detail: string;
  canRetry: boolean;
};

export function createPanel(options: {
  getContext: () => TavernContext;
  getDriveState: () => DriveConnectionState;
  onSave: (settings: Settings) => void;
  onConnectDrive: () => Promise<DriveConnectionState>;
  onManualUpload: () => Promise<string>;
  onBackupEnvironment: (
    items: EnvironmentItemKind[],
    onProgress: (event: EnvironmentProgressEvent) => void
  ) => Promise<EnvironmentBackupResult[]>;
  onRestoreEnvironment: (
    items: EnvironmentItemKind[],
    onProgress: (event: EnvironmentProgressEvent) => void
  ) => Promise<EnvironmentRestoreResult>;
  onPreviewRestore: (items: EnvironmentItemKind[]) => Promise<Record<EnvironmentItemKind, boolean>>;
  onDownloadLatest: () => Promise<string>;
  onListCloudRoles: () => Promise<CloudRoleEntry[]>;
  onListCloudChats: (roleKey: string) => Promise<CloudChatEntry[]>;
  onPullChat: (roleKey: string, chatId: string) => Promise<PullResult>;
}): PanelController {
  let root: HTMLElement | null = null;
  let context = options.getContext();
  let driveState = options.getDriveState();

  let progressOp: ProgressOp | null = null;
  let progressTitle = '';
  let progressRows: ProgressRow[] = [];
  let lastPullTarget: { roleKey: string; chatId: string } | null = null;

  function mount(): void {
    if (root) {
      return;
    }
    const hostDocument = getHostDocument();
    root = hostDocument.createElement('section');
    root.id = 'tavern-roamer-panel';
    root.innerHTML = renderPanel(loadSettings(), context, driveState);
    const mountPoint = findMountPoint(hostDocument);
    if (mountPoint === hostDocument.body) {
      root.classList.add('tr-floating');
    }
    injectStyle(hostDocument);
    mountPoint.append(root);
    bindEvents();
    applyConnectionGuards();
  }

  function updateContext(nextContext: TavernContext, info?: PanelStatusInfo): void {
    context = nextContext;
    if (!root) {
      return;
    }
    setText('character', context.characterName ?? '未選取');
    setText('chat-id', context.chatId ?? '尚未同步');
    setText('chat-file', context.chatFileName ?? '未知');

    const pill = statusPill(context.status);
    const statusEl = root.querySelector<HTMLElement>('[data-field="status"]');
    if (statusEl) {
      statusEl.className = `tr-pill tr-tone-${pill.tone}`;
      statusEl.textContent = pill.label;
    }

    const autoEl = root.querySelector<HTMLElement>('[data-field="auto-sync"]');
    if (autoEl) {
      autoEl.textContent = formatAutoSyncLabel(loadSettings());
    }

    if (info) {
      setText('last-synced', formatLastSyncedLabel(info.lastSyncedVersion));
      const queueEl = root.querySelector<HTMLElement>('[data-field="queue"]');
      if (queueEl) {
        const queue = formatPendingLabel(info.pendingUploads);
        queueEl.textContent = queue.text;
        queueEl.classList.toggle('tr-warn-text', queue.tone === 'warn');
      }
    }
  }

  function updateDriveStatus(nextState: DriveConnectionState): void {
    driveState = nextState;
    if (!root) {
      return;
    }
    setText('drive', driveState.connected ? '已連線' : '未連線');
    const email = root.querySelector<HTMLElement>('[data-field="drive-email"]');
    if (email) {
      email.textContent = driveState.email ?? (driveState.error ? `錯誤：${driveState.error}` : '-');
    }
    applyConnectionGuards();
  }

  function probe(): PanelHealth {
    const panelEl = findMountedPanel();
    const drawer = panelEl?.querySelector('.inline-drawer') ?? null;
    const toggle = panelEl?.querySelector('.inline-drawer-toggle') ?? null;
    const content = panelEl?.querySelector('.inline-drawer-content') ?? null;
    return {
      mounted: Boolean(panelEl),
      hasInlineDrawer: Boolean(drawer && toggle && content),
      toggleReady: Boolean(toggle && content),
      details: {
        id: panelEl?.id ?? null,
        mountedTo: panelEl?.parentElement?.id ?? null,
        floating: panelEl?.classList.contains('tr-floating') ?? false
      }
    };
  }

  // ── 進度清單 ───────────────────────────────────────────────────

  function renderProgress(): void {
    const el = root?.querySelector<HTMLElement>('[data-field="progress"]');
    if (!el) {
      return;
    }
    if (progressRows.length === 0) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const settled = progressRows.filter(row => isSettled(row.state)).length;
    const total = progressRows.length;
    const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
    el.innerHTML = `
      <div class="tr-progress-head">
        <span class="tr-progress-title">${escapeHtml(progressTitle)}</span>
        <span class="tr-progress-count">${progressRatioLabel(settled, total)}</span>
      </div>
      <div class="tr-progressbar"><i style="width:${pct}%"></i></div>
      <ul class="tr-progress-list">
        ${progressRows.map(renderProgressRow).join('')}
      </ul>
    `;
  }

  function beginProgress(op: ProgressOp, title: string, rows: ProgressRow[]): void {
    progressOp = op;
    progressTitle = title;
    progressRows = rows;
    renderProgress();
  }

  /** 為指定 kinds 建立/重置進度列（重試時保留其他列）。 */
  function ensureRows(kinds: EnvironmentItemKind[]): void {
    for (const kind of kinds) {
      const existing = progressRows.find(row => row.key === kind);
      const fresh: ProgressRow = { key: kind, label: BACKUP_ITEM_LABELS[kind], state: 'pending', detail: '等待中', canRetry: false };
      if (existing) {
        Object.assign(existing, fresh);
      } else {
        progressRows.push(fresh);
      }
    }
  }

  function patchRow(key: string, patch: Partial<ProgressRow>): void {
    const row = progressRows.find(item => item.key === key);
    if (row) {
      Object.assign(row, patch);
      renderProgress();
    }
  }

  async function runBackup(kinds: EnvironmentItemKind[]): Promise<void> {
    if (progressOp !== 'backup' || progressRows.length === 0) {
      beginProgress('backup', '備份完整環境', []);
    }
    progressOp = 'backup';
    progressTitle = '備份完整環境';
    ensureRows(kinds);
    renderProgress();
    try {
      const results = await options.onBackupEnvironment(kinds, applyBackupEvent);
      applyBackupResults(results);
    } catch (error) {
      for (const kind of kinds) {
        patchRow(kind, { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
      }
    }
    renderProgress();
  }

  function applyBackupEvent(event: EnvironmentProgressEvent): void {
    if (event.state === 'start') {
      patchRow(event.kind, { state: 'active', detail: event.step === 'upload' ? '上傳中…' : '匯出中…' });
      return;
    }
    if (event.state === 'error') {
      patchRow(event.kind, { state: 'error', detail: `失敗：${event.error ?? '未知錯誤'}`, canRetry: true });
      return;
    }
    if (event.step === 'upload') {
      patchRow(event.kind, { state: 'done', detail: event.filename ?? '完成', canRetry: false });
    }
  }

  function applyBackupResults(results: EnvironmentBackupResult[]): void {
    for (const result of results) {
      if (result.status === 'done') {
        patchRow(result.kind, { state: 'done', detail: result.filename ?? '完成', canRetry: false });
      } else {
        patchRow(result.kind, { state: 'error', detail: `失敗：${result.error ?? '未知錯誤'}`, canRetry: true });
      }
    }
  }

  async function runRestore(kinds: EnvironmentItemKind[]): Promise<void> {
    if (progressOp !== 'restore' || progressRows.length === 0) {
      beginProgress('restore', '還原環境', []);
    }
    progressOp = 'restore';
    progressTitle = '還原環境';
    ensureRows(kinds);
    renderProgress();
    try {
      const result = await options.onRestoreEnvironment(kinds, applyRestoreEvent);
      applyRestoreResults(result.items);
    } catch (error) {
      for (const kind of kinds) {
        patchRow(kind, { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
      }
    }
    renderProgress();
  }

  function applyRestoreEvent(event: EnvironmentProgressEvent): void {
    if (event.state === 'error') {
      if (event.step === 'backup_current') {
        patchRow(event.kind, { state: 'aborted', detail: `覆蓋前備份失敗，已中止：${event.error ?? ''}`, canRetry: true });
      } else {
        patchRow(event.kind, { state: 'error', detail: `失敗：${event.error ?? '未知錯誤'}`, canRetry: true });
      }
      return;
    }
    if (event.state === 'start') {
      const detail = event.step === 'backup_current' ? '備份現況…' : event.step === 'download' ? '下載中…' : '套用中…';
      patchRow(event.kind, { state: 'active', detail });
      return;
    }
    // done
    if (event.step === 'download' && event.filename) {
      patchRow(event.kind, { detail: event.filename });
    }
    if (event.step === 'apply') {
      patchRow(event.kind, { state: 'done', canRetry: false });
    }
  }

  function applyRestoreResults(items: EnvironmentRestoreResult['items']): void {
    for (const item of items) {
      if (item.status === 'done') {
        patchRow(item.kind, { state: 'done', detail: item.filename ?? '完成', canRetry: false });
      } else if (item.status === 'skipped') {
        patchRow(item.kind, { state: 'skipped', detail: '雲端無備份，略過', canRetry: false });
      } else if (item.status === 'aborted') {
        patchRow(item.kind, { state: 'aborted', detail: `覆蓋前備份失敗，已中止${item.error ? `：${item.error}` : ''}`, canRetry: true });
      } else {
        patchRow(item.kind, { state: 'error', detail: `失敗：${item.error ?? '未知錯誤'}`, canRetry: true });
      }
    }
  }

  async function runSingle(op: 'upload' | 'download'): Promise<void> {
    const title = op === 'upload' ? '手動上傳目前聊天' : '下載並覆蓋';
    const activeDetail = op === 'upload' ? '上傳中…' : '下載並覆蓋中…';
    beginProgress(op, title, [{ key: op, label: '目前聊天', state: 'active', detail: activeDetail, canRetry: false }]);
    try {
      const filename = op === 'upload' ? await options.onManualUpload() : await options.onDownloadLatest();
      patchRow(op, { state: 'done', detail: op === 'upload' ? filename : `已覆蓋為 ${filename}`, canRetry: false });
    } catch (error) {
      patchRow(op, { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
    }
  }

  async function showCloudRoles(): Promise<void> {
    const el = root?.querySelector<HTMLElement>('[data-field="cloud-list"]');
    if (!el) {
      return;
    }
    el.hidden = false;
    el.innerHTML = '<p class="tr-cloud-empty">載入中…</p>';
    try {
      el.innerHTML = renderCloudRoleListHtml(await options.onListCloudRoles());
    } catch (error) {
      el.innerHTML = `<p class="tr-cloud-empty">讀取失敗：${escapeHtml(errorMessage(error))}</p>`;
    }
  }

  async function showCloudChats(roleKey: string): Promise<void> {
    const el = root?.querySelector<HTMLElement>('[data-field="cloud-list"]');
    if (!el) {
      return;
    }
    el.innerHTML = '<p class="tr-cloud-empty">載入中…</p>';
    try {
      el.innerHTML = renderCloudChatListHtml(roleKey, await options.onListCloudChats(roleKey));
    } catch (error) {
      el.innerHTML = `<p class="tr-cloud-empty">讀取失敗：${escapeHtml(errorMessage(error))}</p>`;
    }
  }

  async function runPull(roleKey: string, chatId: string): Promise<void> {
    beginProgress('pull', '從雲端拉取聊天', [
      { key: 'pull', label: chatId, state: 'active', detail: '拉取中…', canRetry: false }
    ]);
    try {
      const result = await options.onPullChat(roleKey, chatId);
      patchRow('pull', {
        state: 'done',
        detail: `已建立 ${result.chatFileName}（來源 ${result.filename}）`,
        canRetry: false
      });
    } catch (error) {
      patchRow('pull', { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
    }
  }

  function retryRow(key: string): void {
    if (progressOp === 'backup' && isItemKind(key)) {
      void runBackup([key]);
    } else if (progressOp === 'restore' && isItemKind(key)) {
      void runRestore([key]);
    } else if (progressOp === 'upload') {
      void runSingle('upload');
    } else if (progressOp === 'download') {
      void runSingle('download');
    } else if (progressOp === 'pull' && lastPullTarget) {
      void runPull(lastPullTarget.roleKey, lastPullTarget.chatId);
    }
  }

  // ── 事件綁定 ───────────────────────────────────────────────────

  function bindEvents(): void {
    if (!root) {
      return;
    }

    root.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => {
      if (!root) return;
      const settings = collectSettings(root);
      const saved = saveSettings(settings);
      options.onSave(saved);
      refreshSettingsGuidance(saved);
      const autoEl = root.querySelector<HTMLElement>('[data-field="auto-sync"]');
      if (autoEl) autoEl.textContent = formatAutoSyncLabel(saved);
      setReport('設定已儲存');
    });

    root.querySelector<HTMLButtonElement>('[data-action="connect-drive"]')?.addEventListener('click', async () => {
      setReport('Google Drive 授權中...');
      try {
        if (!root) return;
        const saved = saveSettings(collectSettings(root));
        options.onSave(saved);
        refreshSettingsGuidance(saved);
        const state = await options.onConnectDrive();
        updateDriveStatus(state);
        setReport(state.connected ? 'Google Drive 已連線' : `Google Drive 未連線：${state.error ?? '未知錯誤'}`);
      } catch (error) {
        updateDriveStatus({ connected: false, email: null, error: errorMessage(error) });
        setReport(errorMessage(error));
      }
    });

    root.querySelector<HTMLButtonElement>('[data-action="manual-upload"]')?.addEventListener('click', () => {
      void runSingle('upload');
    });

    root.querySelector<HTMLButtonElement>('[data-action="download-latest"]')?.addEventListener('click', async () => {
      const ok = await confirmDialog(
        '下載並覆蓋',
        '<p>此操作會以雲端最新版本<b>覆蓋目前聊天內容</b>，覆蓋後無法復原。</p><p>確定要繼續嗎？</p>',
        '此操作會以雲端最新版本覆蓋目前聊天內容，覆蓋後無法復原。確定要繼續嗎？'
      );
      if (!ok) {
        setReport('已取消下載覆蓋');
        return;
      }
      void runSingle('download');
    });

    root.querySelector<HTMLButtonElement>('[data-action="browse-cloud"]')?.addEventListener('click', () => {
      void showCloudRoles();
    });

    root.querySelector<HTMLElement>('[data-field="cloud-list"]')?.addEventListener('click', async event => {
      const target = event.target as HTMLElement | null;
      const roleButton = target?.closest<HTMLElement>('[data-cloud-role]');
      if (roleButton) {
        await showCloudChats(roleButton.getAttribute('data-cloud-role') ?? '');
        return;
      }
      if (target?.closest('[data-cloud-back]')) {
        await showCloudRoles();
        return;
      }
      const pullButton = target?.closest<HTMLElement>('[data-cloud-pull-role]');
      if (!pullButton || pullButton.hasAttribute('disabled')) {
        return;
      }
      const roleKey = pullButton.getAttribute('data-cloud-pull-role') ?? '';
      const chatId = pullButton.getAttribute('data-cloud-pull-chat') ?? '';
      const ok = await confirmDialog(
        '從雲端拉取聊天',
        `<p>將在本地建立新聊天：</p><p><b>${escapeHtml(roleKey)}</b> / <code>${escapeHtml(chatId)}</code></p>` +
          '<p>若本地沒有這張角色卡，會先嘗試從雲端備份還原角色卡。</p>',
        `將在本地建立新聊天：${roleKey} / ${chatId}。若本地沒有角色卡會先嘗試從雲端還原。`
      );
      if (!ok) {
        setReport('已取消拉取');
        return;
      }
      lastPullTarget = { roleKey, chatId };
      await runPull(roleKey, chatId);
    });

    root.querySelector<HTMLButtonElement>('[data-action="backup-environment"]')?.addEventListener('click', () => {
      const selectedItems = collectSelectedItems();
      if (selectedItems.length === 0) {
        setReport('請先勾選至少一個環境項目');
        return;
      }
      beginProgress('backup', '備份完整環境', []);
      void runBackup(selectedItems);
    });

    root.querySelector<HTMLButtonElement>('[data-action="restore-environment"]')?.addEventListener('click', async () => {
      const selectedItems = collectSelectedItems();
      if (selectedItems.length === 0) {
        setReport('請先勾選至少一個環境項目');
        return;
      }
      let overwrite = selectedItems;
      let skipped: EnvironmentItemKind[] = [];
      try {
        const preview = await options.onPreviewRestore(selectedItems);
        overwrite = selectedItems.filter(kind => preview[kind]);
        skipped = selectedItems.filter(kind => !preview[kind]);
      } catch {
        // 預檢失敗：保守起見全部視為將被覆蓋，仍照常二次確認
      }
      const ok = await confirmDialog('還原環境', buildRestoreConfirmHtml(overwrite, skipped), buildRestoreConfirmText(overwrite, skipped));
      if (!ok) {
        setReport('已取消還原');
        return;
      }
      beginProgress('restore', '還原環境', []);
      void runRestore(selectedItems);
    });

    root.querySelector<HTMLButtonElement>('[data-action="self-check"]')?.addEventListener('click', async () => {
      setReport('自檢執行中...');
      const results = await runSelfChecks();
      setReport(results.map(result => `${statusIcon(result.status)} ${result.label}: ${result.message} (${result.durationMs}ms)`).join('\n'));
    });

    // 進度清單「重試」以事件委派處理（每次 renderProgress 會重寫 innerHTML）
    root.querySelector<HTMLElement>('[data-field="progress"]')?.addEventListener('click', event => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-retry-key]');
      const key = target?.getAttribute('data-retry-key');
      if (key) {
        retryRow(key);
      }
    });

    // 連線與設定小節收合（自寫 toggle：非主 drawer，酒館全域委派不涵蓋）
    const settingsToggle = root.querySelector<HTMLElement>('[data-action="toggle-settings"]');
    settingsToggle?.addEventListener('click', () => {
      const content = root?.querySelector<HTMLElement>('[data-settings-content]');
      const icon = settingsToggle.querySelector<HTMLElement>('.tr-section-icon');
      if (!content) return;
      const collapsed = content.hidden;
      content.hidden = !collapsed;
      icon?.classList.toggle('tr-collapsed', !collapsed);
    });

    // 浮動模式（掛到 body、非 extensions_settings）宿主沒有 inline-drawer 全域委派，
    // 自行補一個收合 toggle；掛到宿主面板時交給酒館的全域點擊委派處理。
    if (root.classList.contains('tr-floating')) {
      const toggle = root.querySelector<HTMLElement>('.inline-drawer-toggle');
      const content = root.querySelector<HTMLElement>('.inline-drawer-content');
      const icon = root.querySelector<HTMLElement>('.inline-drawer-icon');
      toggle?.addEventListener('click', () => {
        if (!content) {
          return;
        }
        const isOpen = content.style.display !== 'none';
        content.style.display = isOpen ? 'none' : '';
        icon?.classList.toggle('down');
        icon?.classList.toggle('up');
      });
    }
  }

  function applyConnectionGuards(): void {
    if (!root) {
      return;
    }
    for (const action of DRIVE_GUARDED_ACTIONS) {
      const button = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if (!button) {
        continue;
      }
      if (driveState.connected) {
        button.disabled = false;
        button.removeAttribute('title');
        button.classList.remove('tr-disabled');
      } else {
        button.disabled = true;
        button.title = DRIVE_GUARD_TITLE;
        button.classList.add('tr-disabled');
      }
    }
  }

  function refreshSettingsGuidance(settings: Settings): void {
    if (!root) {
      return;
    }
    const guidance = root.querySelector<HTMLElement>('[data-field="guidance"]');
    if (guidance) {
      guidance.hidden = Boolean(settings.googleClientId.trim());
    }
  }

  function collectSelectedItems(): EnvironmentItemKind[] {
    if (!root) {
      return [...DEFAULT_BACKUP_ITEMS];
    }
    return DEFAULT_BACKUP_ITEMS.filter(item =>
      Boolean(root?.querySelector<HTMLInputElement>(`[data-input="backup-${item}"]`)?.checked)
    );
  }

  function setText(field: string, value: string): void {
    const el = root?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (el) {
      el.textContent = value;
    }
  }

  function setReport(text: string): void {
    const report = root?.querySelector<HTMLElement>('[data-field="report"]');
    if (report) {
      report.textContent = text;
    }
  }

  function renderProgressRow(row: ProgressRow): string {
    const retry = row.canRetry
      ? `<button type="button" class="menu_button tr-retry" data-retry-key="${escapeAttribute(row.key)}">重試</button>`
      : '';
    return `
      <li class="tr-progress-row tr-row-${row.state}">
        <span class="tr-row-icon">${progressIcon(row.state)}</span>
        <span class="tr-row-label">${escapeHtml(row.label)}</span>
        <span class="tr-row-detail">${escapeHtml(row.detail)}</span>
        ${retry}
      </li>
    `;
  }

  return { mount, updateContext, updateDriveStatus, probe };
}

// ── 版面 ───────────────────────────────────────────────────────────

function renderPanel(settings: Settings, context: TavernContext, driveState: DriveConnectionState): string {
  const pill = statusPill(context.status);
  const pending = formatPendingLabel(0);
  const settingsCollapsed = Boolean(settings.googleClientId.trim());
  return `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>TavernRoamer</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="tr-body">

          <section class="tr-section" data-section="status">
            <div class="tr-grid">
              <span>Google Drive</span><b data-field="drive">${driveState.connected ? '已連線' : '未連線'}</b>
              <span>連線帳號</span><b data-field="drive-email">${escapeHtml(driveState.email ?? '-')}</b>
              <span>目前角色</span><b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b>
              <span>聊天檔</span><b data-field="chat-file">${escapeHtml(context.chatFileName ?? '未知')}</b>
              <span>chat_id</span><b data-field="chat-id">${escapeHtml(context.chatId ?? '尚未同步')}</b>
              <span>狀態</span><b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b>
              <span>最後同步</span><b data-field="last-synced">—</b>
              <span>待傳佇列</span><b data-field="queue">${pending.text}</b>
              <span>自動同步</span><b data-field="auto-sync">${formatAutoSyncLabel(settings)}</b>
            </div>
          </section>

          <section class="tr-section" data-section="daily">
            <div class="tr-section-title">日常操作</div>
            <div class="tr-actions flex-container flexGap5">
              ${iconButton('manual-upload', 'fa-upload', '手動上傳目前聊天')}
              ${iconButton('download-latest', 'fa-download', '下載並覆蓋')}
            </div>
          </section>

          <section class="tr-section" data-section="cloud-pull">
            <div class="tr-section-title">從雲端拉取</div>
            <div class="tr-actions flex-container flexGap5">
              ${iconButton('browse-cloud', 'fa-cloud-arrow-down', '瀏覽雲端備份')}
            </div>
            <div class="tr-cloud" data-field="cloud-list" hidden></div>
          </section>

          <section class="tr-section" data-section="environment">
            <div class="tr-section-title">環境備份 / 還原</div>
            <fieldset class="tr-fieldset">
              <legend>環境備份項目</legend>
              ${DEFAULT_BACKUP_ITEMS.map(
                item => `
                <label class="checkbox_label">
                  <input data-input="backup-${item}" type="checkbox" checked />
                  <span>${BACKUP_ITEM_LABELS[item]}</span>
                </label>
              `
              ).join('')}
            </fieldset>
            <div class="tr-actions flex-container flexGap5">
              ${iconButton('backup-environment', 'fa-box-archive', '備份完整環境')}
              ${iconButton('restore-environment', 'fa-box-open', '還原環境')}
            </div>
            <div class="tr-progress" data-field="progress" aria-live="polite" hidden></div>
          </section>

          <section class="tr-section" data-section="settings">
            <div class="tr-section-title tr-section-toggle" data-action="toggle-settings">
              <span>連線與設定</span>
              <i class="fa-solid fa-chevron-down tr-section-icon ${settingsCollapsed ? 'tr-collapsed' : ''}"></i>
            </div>
            <div class="tr-settings-content" data-settings-content ${settingsCollapsed ? 'hidden' : ''}>
              <p class="tr-guidance" data-field="guidance" ${settingsCollapsed ? 'hidden' : ''}>
                首次使用請先填入 Google Client ID 並點「連線 Google Drive」完成授權，才能上傳、下載與備份。
              </p>
              <label class="tr-field">
                <span>Google Client ID</span>
                <input class="text_pole" data-input="googleClientId" value="${escapeAttribute(settings.googleClientId)}" autocomplete="off" />
              </label>
              <label class="tr-field">
                <span>裝置名稱</span>
                <input class="text_pole" data-input="deviceName" value="${escapeAttribute(settings.deviceName)}" autocomplete="off" />
              </label>
              <label class="tr-field tr-inline">
                <span>自動同步每 N 則</span>
                <input class="text_pole" data-input="autoSyncEveryN" type="number" min="1" step="1" value="${settings.autoSyncEveryN}" />
              </label>
              <label class="checkbox_label">
                <input data-input="autoSyncEnabled" type="checkbox" ${settings.autoSyncEnabled ? 'checked' : ''} />
                <span>啟用自動同步</span>
              </label>
              <div class="tr-actions flex-container flexGap5">
                ${iconButton('connect-drive', 'fa-plug', '連線 Google Drive')}
                ${iconButton('save', 'fa-save', '儲存設定')}
                ${iconButton('self-check', 'fa-stethoscope', '自檢')}
              </div>
            </div>
          </section>

          <pre data-field="report" class="tr-report" aria-live="polite"></pre>
        </div>
      </div>
    </div>
  `;
}

function iconButton(action: string, icon: string, label: string): string {
  return `<button type="button" class="menu_button menu_button_icon" data-action="${action}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
}

export function renderCloudRoleListHtml(roles: CloudRoleEntry[]): string {
  if (roles.length === 0) {
    return '<p class="tr-cloud-empty">雲端沒有任何備份資料夾</p>';
  }
  const items = roles
    .map(
      role => `
        <li>
          <button type="button" class="menu_button tr-cloud-role" data-cloud-role="${escapeAttribute(role.roleKey)}">
            <i class="fa-solid fa-user"></i><span>${escapeHtml(role.roleKey)}</span>
          </button>
        </li>`
    )
    .join('');
  return `<div class="tr-cloud-head"><b>選擇角色</b></div><ul class="tr-cloud-list">${items}</ul>`;
}

export function renderCloudChatListHtml(roleKey: string, entries: CloudChatEntry[]): string {
  const rows = entries
    .map(entry => {
      const latestLabel = entry.latest ? formatLastSyncedLabel(entry.latest.filename) : '—';
      const device = entry.latest?.device ?? '—';
      return `
        <li class="tr-cloud-chat-row">
          <span class="tr-cloud-chat-id">${escapeHtml(entry.chatId)}</span>
          <span class="tr-cloud-chat-info">${escapeHtml(latestLabel)}｜${escapeHtml(device)}｜${entry.versionCount} 版</span>
          <button type="button" class="menu_button tr-cloud-pull"
            data-cloud-pull-role="${escapeAttribute(roleKey)}"
            data-cloud-pull-chat="${escapeAttribute(entry.chatId)}"
            ${entry.versionCount === 0 ? 'disabled' : ''}>拉取</button>
        </li>`;
    })
    .join('');
  return `
    <div class="tr-cloud-head">
      <button type="button" class="menu_button tr-cloud-back" data-cloud-back="1">
        <i class="fa-solid fa-arrow-left"></i><span>返回角色</span>
      </button>
      <b>${escapeHtml(roleKey)}</b>
    </div>
    <ul class="tr-cloud-list">${rows.length > 0 ? rows : '<li class="tr-cloud-empty">這個角色底下沒有聊天</li>'}</ul>
  `;
}

function progressIcon(state: ProgressRowState): string {
  switch (state) {
    case 'active':
      return '<i class="fa-solid fa-spinner fa-spin"></i>';
    case 'done':
      return '<span class="tr-ok">✓</span>';
    case 'error':
      return '<span class="tr-err">✗</span>';
    case 'aborted':
      return '<span class="tr-abort">⚠</span>';
    case 'skipped':
    case 'pending':
    default:
      return '<span class="tr-dot">·</span>';
  }
}

function buildRestoreConfirmHtml(overwrite: EnvironmentItemKind[], skipped: EnvironmentItemKind[]): string {
  const overwriteText = overwrite.length > 0 ? overwrite.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
  const skippedText = skipped.length > 0 ? skipped.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
  return `
    <p>還原前會先將目前內容備份到雲端 <code>_pre_restore</code>，再以雲端最新版本覆蓋。</p>
    <p><b>將被覆蓋（有雲端備份）：</b>${escapeHtml(overwriteText)}</p>
    <p><b>雲端沒有備份、將略過：</b>${escapeHtml(skippedText)}</p>
    <p>確定要還原嗎？</p>
  `;
}

function buildRestoreConfirmText(overwrite: EnvironmentItemKind[], skipped: EnvironmentItemKind[]): string {
  const overwriteText = overwrite.length > 0 ? overwrite.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
  const skippedText = skipped.length > 0 ? skipped.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
  return [
    '還原前會先將目前內容備份到雲端 _pre_restore，再以雲端最新版本覆蓋。',
    `將被覆蓋（有雲端備份）：${overwriteText}`,
    `雲端沒有備份、將略過：${skippedText}`,
    '確定要還原嗎？'
  ].join('\n');
}

async function confirmDialog(title: string, html: string, text: string): Promise<boolean> {
  try {
    // 優先取宿主酒館的 callGenericPopup（try globalThis.parent 上的 SillyTavern.getContext()）
    const globals = globalThis as Record<string, any>;
    const provider = globals.parent?.SillyTavern ?? globals.SillyTavern;
    const ctx = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
    const popup = ctx?.callGenericPopup;
    if (typeof popup === 'function') {
      const popupType = ctx?.POPUP_TYPE?.CONFIRM ?? 2;
      const result = await popup(`<h3>${escapeHtml(title)}</h3>${html}`, popupType, '', {
        okButton: '確定',
        cancelButton: '取消'
      });
      return Boolean(result);
    }
  } catch {
    // 取不到酒館 popup → 退回 confirm()
  }
  const confirmFn = typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : null;
  return confirmFn ? confirmFn(`${title}\n\n${text}`) : true;
}

function isSettled(state: ProgressRowState): boolean {
  return state === 'done' || state === 'error' || state === 'aborted' || state === 'skipped';
}

function isItemKind(value: string): value is EnvironmentItemKind {
  return (DEFAULT_BACKUP_ITEMS as string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectSettings(root: HTMLElement): Settings {
  const current = loadSettings();
  const deviceName = root.querySelector<HTMLInputElement>('[data-input="deviceName"]')?.value ?? current.deviceName;
  const googleClientId = root.querySelector<HTMLInputElement>('[data-input="googleClientId"]')?.value ?? current.googleClientId;
  const autoSyncEveryN = Number(root.querySelector<HTMLInputElement>('[data-input="autoSyncEveryN"]')?.value);
  const autoSyncEnabled = Boolean(root.querySelector<HTMLInputElement>('[data-input="autoSyncEnabled"]')?.checked);
  return {
    ...current,
    deviceName,
    googleClientId,
    autoSyncEnabled,
    autoSyncEveryN: Number.isInteger(autoSyncEveryN) && autoSyncEveryN > 0 ? autoSyncEveryN : current.autoSyncEveryN
  };
}

function getHostDocument(): Document {
  try {
    const parentDocument = globalThis.parent?.document;
    if (parentDocument?.querySelector('#extensions_settings2, #extensions_settings')) {
      return parentDocument;
    }
  } catch {
    return document;
  }
  return document;
}

function findMountedPanel(): HTMLElement | null {
  try {
    const parentPanel = globalThis.parent?.document?.querySelector<HTMLElement>('#tavern-roamer-panel');
    if (parentPanel) {
      return parentPanel;
    }
  } catch {
    // 跨域或無 parent → 退回自身 document
  }
  return document.querySelector<HTMLElement>('#tavern-roamer-panel');
}

function findMountPoint(hostDocument: Document): HTMLElement {
  return (
    hostDocument.querySelector<HTMLElement>('#extensions_settings2') ??
    hostDocument.querySelector<HTMLElement>('#extensions_settings') ??
    hostDocument.body
  );
}

function injectStyle(hostDocument: Document): void {
  if (hostDocument.querySelector('#tavern-roamer-style')) {
    return;
  }
  const style = hostDocument.createElement('style');
  style.id = 'tavern-roamer-style';
  style.textContent = `
    /* 掛在宿主面板時，外觀交給酒館的 inline-drawer / menu_button / text_pole；
       這裡只保留佈局，顏色一律吃 --SmartTheme* 主題變數並附 fallback。 */
    #tavern-roamer-panel {
      margin: 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--SmartThemeBodyColor, currentColor);
    }
    #tavern-roamer-panel .tr-body {
      display: grid;
      gap: 14px;
      padding: 8px 0 2px;
    }
    #tavern-roamer-panel .tr-section {
      display: grid;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-section-title {
      font-weight: 600;
      opacity: .82;
      border-bottom: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 18%, transparent));
      padding-bottom: 4px;
    }
    #tavern-roamer-panel .tr-section-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    #tavern-roamer-panel .tr-section-icon {
      transition: transform .15s ease;
    }
    #tavern-roamer-panel .tr-section-icon.tr-collapsed {
      transform: rotate(-90deg);
    }
    #tavern-roamer-panel .tr-grid {
      display: grid;
      grid-template-columns: minmax(90px, max-content) minmax(0, 1fr);
      gap: 6px 12px;
      align-items: baseline;
    }
    #tavern-roamer-panel .tr-grid span,
    #tavern-roamer-panel .tr-field > span,
    #tavern-roamer-panel .tr-fieldset legend {
      opacity: .72;
    }
    #tavern-roamer-panel .tr-grid b {
      font-weight: 600;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    /* 狀態色點 pill：文字吃主題色，顏色由色點呈現，低飽和且暗亮主題皆可讀 */
    #tavern-roamer-panel .tr-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-pill::before {
      content: '';
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--tr-tone, #9aa0a6);
      flex: 0 0 auto;
    }
    #tavern-roamer-panel .tr-tone-green { --tr-tone: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-tone-yellow { --tr-tone: var(--tr-c-yellow, #d6b34a); }
    #tavern-roamer-panel .tr-tone-orange { --tr-tone: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-tone-grey { --tr-tone: var(--tr-c-grey, #9aa0a6); }
    #tavern-roamer-panel .tr-warn-text {
      color: var(--tr-c-orange, #d98a4a);
      font-weight: 700;
    }
    #tavern-roamer-panel .tr-guidance {
      margin: 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 40%, transparent);
      opacity: .95;
    }
    #tavern-roamer-panel .tr-field {
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-inline {
      grid-template-columns: minmax(120px, max-content) minmax(72px, 120px);
      align-items: center;
    }
    #tavern-roamer-panel .tr-fieldset {
      margin: 0;
      padding: 8px 10px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 6px;
      display: grid;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-settings-content {
      display: grid;
      gap: 10px;
    }
    #tavern-roamer-panel .tr-settings-content[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-disabled,
    #tavern-roamer-panel .menu_button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    /* 進度清單 */
    #tavern-roamer-panel .tr-progress {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 18%, transparent));
      border-radius: 6px;
    }
    /* 作者規則會蓋過 UA 的 [hidden]{display:none}，需明確補回，否則空進度框仍會顯示 */
    #tavern-roamer-panel .tr-progress[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-progress-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-progress-count {
      opacity: .72;
      font-variant-numeric: tabular-nums;
    }
    #tavern-roamer-panel .tr-progressbar {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, currentColor 15%, transparent);
    }
    #tavern-roamer-panel .tr-progressbar > i {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--SmartThemeQuoteColor, var(--tr-c-green, #5bbd7a));
      transition: width .2s ease;
    }
    #tavern-roamer-panel .tr-progress-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-progress-row {
      display: grid;
      grid-template-columns: 18px minmax(56px, max-content) minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: center;
    }
    #tavern-roamer-panel .tr-row-detail {
      opacity: .78;
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-row-icon { text-align: center; }
    #tavern-roamer-panel .tr-ok { color: var(--tr-c-green, #5bbd7a); font-weight: 700; }
    #tavern-roamer-panel .tr-err { color: var(--tr-c-red, #d05a5a); font-weight: 700; }
    #tavern-roamer-panel .tr-abort { color: var(--tr-c-orange, #d98a4a); font-weight: 700; }
    #tavern-roamer-panel .tr-dot { opacity: .5; }
    #tavern-roamer-panel .tr-retry {
      padding: 2px 8px;
      font-size: 12px;
    }
    #tavern-roamer-panel .tr-cloud {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 18%, transparent));
      border-radius: 6px;
    }
    #tavern-roamer-panel .tr-cloud[hidden] { display: none; }
    #tavern-roamer-panel .tr-cloud-head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-cloud-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-cloud-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content max-content;
      gap: 8px;
      align-items: center;
    }
    #tavern-roamer-panel .tr-cloud-chat-id {
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-cloud-chat-info {
      opacity: .72;
      font-size: 12px;
      white-space: nowrap;
    }
    #tavern-roamer-panel .tr-cloud-empty {
      margin: 0;
      opacity: .72;
    }
    #tavern-roamer-panel .tr-report {
      margin: 0;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 180px;
      padding: 8px;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
      color: var(--SmartThemeBodyColor, currentColor);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-report:empty { display: none; }

    /* 浮動保底：掛到 body（iframe 自身 document）時酒館的元件 class 與主題變數
       不存在，需一組 scoped 保底樣式，只在 .tr-floating 下生效。 */
    #tavern-roamer-panel.tr-floating {
      position: fixed;
      z-index: 100000;
      right: 16px;
      bottom: 16px;
      width: min(420px, calc(100vw - 32px));
      max-height: min(720px, calc(100vh - 32px));
      overflow: auto;
      padding: 12px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 8px;
      background: var(--SmartThemeBlurTintColor, color-mix(in srgb, canvas 96%, currentColor 4%));
      box-shadow: 0 14px 36px var(--black30a, rgba(0, 0, 0, .28));
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      font-weight: 600;
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-icon {
      transition: transform .15s ease;
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-icon.up {
      transform: rotate(180deg);
    }
    #tavern-roamer-panel.tr-floating .menu_button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: inherit;
      background: color-mix(in srgb, currentColor 8%, transparent);
      font-size: 12px;
    }
    #tavern-roamer-panel.tr-floating .text_pole {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      padding: 6px 8px;
      background: color-mix(in srgb, canvas 96%, currentColor 4%);
      color: inherit;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label input {
      width: auto;
    }
  `;
  hostDocument.head.append(style);
}

function statusIcon(status: string): string {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  return 'SKIP';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => escapeMap[char] ?? char);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

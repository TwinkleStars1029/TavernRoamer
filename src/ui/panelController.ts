import type { EnvironmentItemKind, EnvironmentProgressEvent } from '../environment/types';
import type { RestorePointFile, RestorePointSelection, RestorePointTarget } from '../restorePoints/types';
import type {
  DriveConnectionState,
  PanelStatusInfo,
  SelfCheckMode,
  SelfCheckResult,
  Settings,
  TavernContext
} from '../types';
import {
  formatAutoSyncLabel,
  progressRatioLabel,
  statusPill,
  summarizeProgress,
  uploadCompletionMessage,
  type ProgressSummary
} from './formatters';
import { escapeHtml } from './html';
import { injectStyle } from './styles';
import { applyAppearance, defaultAppearance, normalizeAppearance } from './appearance';
import {
  findMountedPanel,
  findMountPoint,
  getFocusableElements,
  getHostDocument,
  isHtmlElement,
  prepareFloatingHost
} from './panelHost';
import {
  buildSelfCheckReport,
  renderSelfCheckResultsHtml
} from './selfCheckReport';
import {
  renderCloudChatListHtml,
  renderCloudRoleListHtml,
  renderPanel,
  renderRestorePointChatListHtml,
  renderRestorePointListHtml,
  renderRestorePreviewErrorHtml,
  renderRestorePreviewHtml,
  renderChatUploadPreparationHtml,
  renderHomeCurrentAction,
  renderHomeCurrentAvatar,
  renderHomeCurrentMeta
} from './views/panel';
import type {
  ChatUploadPreparationView,
  EnvironmentBackupViewResult,
  EnvironmentRestoreViewResult,
  PanelController,
  PanelHealth,
  PanelOptions,
  RestorePointBatch,
  RestorePointChatSummary,
  SelfCheckProgressView
} from './types';
import { environmentLabel } from './environmentPresentation';
import { collectEnvironmentSelection } from './environmentSelection';
import { isSettledProgressState, type ProgressOp, type ProgressRow } from './progressModel';
import { renderProgressRow } from './views/progress';
import type { PanelScreen } from './views/shared';

const DRIVE_GUARD_TITLE = '請先連線 Google Drive';
const PROGRESS_LOCK_TITLE = '目前操作完成後，才能開始新的操作';
/** 會開始新進度操作的按鈕；進度執行中一律停用。 */
const PROGRESS_START_ACTIONS = new Set([
  'backup-environment',
  'confirm-restore',
  'download-latest',
  'confirm-cloud-pull',
  'manual-upload',
  'upload-with-environment'
]);
const RESTORE_POINT_SELECTION_ACTIONS = new Set([
  'trash-selected-restore-points',
  'delete-selected-restore-points-permanently'
]);

// ── 面板控制器 ─────────────────────────────────────────────────────

export type { PanelController, PanelHealth, PanelOptions } from './types';

export {
  formatAutoSyncLabel,
  formatPendingLabel,
  progressRatioLabel,
  statusPill,
  summarizeProgress,
  uploadCompletionMessage
} from './formatters';
export type { PillTone, ProgressSummary } from './formatters';
export {
  buildSelfCheckReport,
  renderSelfCheckResultsHtml,
  summarizeSelfChecks
} from './selfCheckReport';
export type { SelfCheckSummary } from './selfCheckReport';
export { floatingHostLayout } from './panelHost';
export {
  renderCloudChatListHtml,
  renderCloudRoleListHtml,
  renderPanel,
  renderRestorePointChatListHtml,
  renderRestorePointListHtml,
  renderRestorePreviewErrorHtml,
  renderRestorePreviewHtml,
  renderChatUploadPreparationHtml
} from './views/panel';
export { renderUploadPreviewHtml } from './views/panel';

export function createPanel(options: PanelOptions): PanelController {
  let root: HTMLElement | null = null;
  let removeViewportListener: (() => void) | null = null;
  let removeKeyboardListener: (() => void) | null = null;
  let restoreFocusTo: HTMLElement | null = null;
  let context = options.getContext();
  let driveState = options.getDriveState();
  let appearanceDraft = normalizeAppearance(options.getSettings().appearance);
  let currentScreen: PanelScreen = 'home';

  let progressOp: ProgressOp | null = null;
  let progressTitle = '';
  let progressRows: ProgressRow[] = [];
  let progressRunning = false;
  let activeProgressTasks = 0;
  let homeStatusInfo: PanelStatusInfo = { lastSyncedVersion: null, pendingUploads: 0 };
  const progressRetryHandlers = new Map<string, () => void>();
  let lastPullTarget: { roleKey: string; chatId: string } | null = null;
  let pendingRestoreItems: EnvironmentItemKind[] = [];
  let restorePreviewReady = false;
  let restorePreviewLoading = false;
  let restorePointChats: RestorePointChatSummary[] = [];
  let restorePointBatches: RestorePointBatch[] = [];
  let restorePointTarget: RestorePointTarget | null = null;
  const selectedRestorePointFiles = new Map<string, RestorePointFile>();
  let restorePointLoadRevision = 0;
  let activeRestorePointLoads = 0;
  let restorePointDestructiveOperationRunning = false;
  let selfCheckRunning = false;
  let selfCheckMode: SelfCheckMode = 'quick';
  let selfCheckProgress: SelfCheckProgressView | null = null;
  let selfCheckResults: SelfCheckResult[] = [];
  let pendingUploadPreparation: ChatUploadPreparationView | null = null;
  let uploadPreviewRevision = 0;
  let statusRefreshRunning = false;
  let queueFlushRunning = false;

  function mount({ floating = false }: { floating?: boolean } = {}): void {
    if (root) {
      return;
    }
    const hostDocument = getHostDocument();
    const activeElement = hostDocument.activeElement;
    restoreFocusTo = floating && isHtmlElement(activeElement, hostDocument) ? activeElement : null;
    root = hostDocument.createElement('section');
    root.id = 'tavern-roamer-panel';
    currentScreen = 'home';
    appearanceDraft = normalizeAppearance(options.getSettings().appearance);
    applyAppearance(root, appearanceDraft);
    root.innerHTML = renderPanel(options.getSettings(), context, driveState, floating, progressRunning, homeStatusInfo);
    const mountPoint = floating ? hostDocument.body : findMountPoint(hostDocument);
    if (floating || mountPoint === hostDocument.body) {
      root.classList.add('tr-floating');
      prepareFloatingHost(root, hostDocument.defaultView ?? window);
    }
    injectStyle(hostDocument);
    mountPoint.append(root);
    if (floating) {
      const targetWindow = hostDocument.defaultView ?? window;
      const syncViewportSize = () => {
        if (root) {
          prepareFloatingHost(root, targetWindow);
        }
      };
      targetWindow.addEventListener('resize', syncViewportSize);
      targetWindow.visualViewport?.addEventListener('resize', syncViewportSize);
      removeViewportListener = () => {
        targetWindow.removeEventListener('resize', syncViewportSize);
        targetWindow.visualViewport?.removeEventListener('resize', syncViewportSize);
      };
    }
    bindEvents();
    applyConnectionGuards();
    if (progressRows.length > 0) {
      renderProgress();
    }
    renderSelfCheckArea();
    if (floating) {
      bindDialogKeyboard(hostDocument);
      focusScreenHeading('home');
    }
  }

  function unmount(): void {
    removeViewportListener?.();
    removeViewportListener = null;
    removeKeyboardListener?.();
    removeKeyboardListener = null;
    root?.remove();
    root = null;
    if (restoreFocusTo?.isConnected) {
      restoreFocusTo.focus({ preventScroll: true });
    }
    restoreFocusTo = null;
  }

  function updateContext(nextContext: TavernContext, info?: PanelStatusInfo): void {
    context = nextContext;
    if (info) {
      homeStatusInfo = info;
    }
    if (!root) {
      return;
    }
    // 只更新狀態卡內容；帶 role="status" 的 .tr-current-status 節點保持不變，讀屏器才會播報變更。
    const avatar = root.querySelector<HTMLElement>('[data-field="home-current-avatar"]');
    if (avatar) avatar.innerHTML = renderHomeCurrentAvatar(context);
    renderHomeMeta();
    renderHomeCta();
    const conflictWarning = root.querySelector<HTMLElement>('[data-field="download-conflict-warning"]');
    if (conflictWarning) conflictWarning.hidden = context.status !== 'conflict';
    setText('character', context.characterName ?? '未選取');
    setText('chat-id', context.chatId ?? '尚未同步');
    setText('chat-file', context.chatFileName ?? '未開啟聊天');
    root.querySelector<HTMLElement>('.tr-current-filename')?.setAttribute('title', context.chatFileName ?? '未開啟聊天');

    const pill = statusPill(context.status);
    for (const statusEl of root.querySelectorAll<HTMLElement>('[data-field="status"]')) {
      statusEl.className = `tr-pill tr-tone-${pill.tone}`;
      statusEl.textContent = pill.label;
    }

    applyConnectionGuards();
  }

  function renderHomeMeta(): void {
    const meta = root?.querySelector<HTMLElement>('[data-field="home-current-meta"]');
    if (meta) meta.innerHTML = renderHomeCurrentMeta(options.getSettings(), homeStatusInfo, queueFlushRunning);
  }

  function renderHomeCta(): void {
    const cta = root?.querySelector<HTMLElement>('[data-field="home-current-cta"]');
    if (cta) cta.innerHTML = renderHomeCurrentAction(context, driveState.connected, progressRunning, statusRefreshRunning);
  }

  function setHomeFeedback(message: string, error = false): void {
    const feedback = root?.querySelector<HTMLElement>('[data-field="home-current-feedback"]');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle('tr-state-error', error);
  }

  async function refreshStatus(): Promise<void> {
    if (statusRefreshRunning) return;
    statusRefreshRunning = true;
    setHomeFeedback('');
    renderHomeCta();
    applyConnectionGuards();
    try {
      await options.onRefreshStatus();
    } catch (error) {
      setHomeFeedback(`重新檢查失敗：${errorMessage(error)}`, true);
    } finally {
      statusRefreshRunning = false;
      renderHomeCta();
      applyConnectionGuards();
    }
  }

  async function flushQueue(): Promise<void> {
    if (queueFlushRunning) return;
    queueFlushRunning = true;
    setHomeFeedback('');
    renderHomeMeta();
    applyConnectionGuards();
    try {
      const result = await options.onFlushQueue();
      setHomeFeedback(result.remaining > 0
        ? `已補傳 ${result.uploaded} 筆，還有 ${result.remaining} 筆未完成`
        : `已補傳 ${result.uploaded} 筆`);
    } catch (error) {
      setHomeFeedback(`補傳失敗：${errorMessage(error)}`, true);
    } finally {
      queueFlushRunning = false;
      renderHomeMeta();
      applyConnectionGuards();
    }
  }

  function updateDriveStatus(nextState: DriveConnectionState): void {
    driveState = nextState;
    if (!root) {
      return;
    }
    setText('drive-identity', driveState.connected ? driveState.email ?? '已連線' : '未連線');
    root.querySelector('[data-field="drive-connection-dot"]')?.classList.toggle('is-connected', driveState.connected);
    const disconnected = root.querySelector<HTMLElement>('[data-field="home-disconnected"]');
    const homeActions = root.querySelector<HTMLElement>('[data-field="home-actions"]');
    const currentSummary = root.querySelector<HTMLElement>('[data-field="home-current"]');
    if (disconnected) disconnected.hidden = driveState.connected;
    if (homeActions) homeActions.hidden = !driveState.connected;
    if (currentSummary) currentSummary.hidden = !driveState.connected;
    root.querySelector<HTMLElement>('[data-field="home-connect-primary"]')
      ?.classList.toggle('tr-primary', !driveState.connected);
    root.querySelector<HTMLElement>('[data-field="home-current-primary"]')
      ?.classList.toggle('tr-primary', driveState.connected);
    applyConnectionGuards();
  }

  function invalidateUploadPreparation(): void {
    pendingUploadPreparation = null;
    uploadPreviewRevision += 1;
    if (!root || currentScreen !== 'upload-confirm') return;
    const preview = root.querySelector<HTMLElement>('[data-field="upload-preview"]');
    if (preview) {
      preview.innerHTML = '<div class="tr-callout tr-danger"><b>目前聊天已變更。</b><br />請回到首頁後重新進入上傳確認。</div>';
      preview.setAttribute('aria-busy', 'false');
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
    const resume = root?.querySelector<HTMLElement>('[data-field="progress-resume"]');
    const lock = root?.querySelector<HTMLElement>('[data-field="home-progress-lock"]');
    if (lock) lock.hidden = !progressRunning;
    if (progressRows.length === 0) {
      el.innerHTML = '';
      el.hidden = true;
      if (resume) resume.hidden = true;
      applyConnectionGuards();
      return;
    }
    el.hidden = false;
    const settled = progressRows.filter(row => isSettledProgressState(row.state)).length;
    const total = progressRows.length;
    const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
    const summary: ProgressSummary = progressRunning
      ? { label: '正在處理', tone: 'running', finished: false }
      : summarizeProgress(progressRows.map(row => row.state));
    const completionMessage = uploadCompletionMessage(
      progressOp,
      progressRows.map(row => row.state)
    );
    const state = root?.querySelector<HTMLElement>('[data-field="progress-state-wrap"]');
    if (state) {
      state.className = `tr-progress-state tr-state-${summary.tone}`;
      state.innerHTML = `${progressSummaryIcon(summary.tone)}<b data-field="progress-state">${escapeHtml(summary.label)}</b>`;
    }
    if (resume) {
      resume.hidden = false;
      const label = resume.querySelector<HTMLElement>('[data-field="progress-resume-label"]');
      const button = resume.querySelector<HTMLElement>('[data-field="progress-resume-action"]');
      const bar = resume.querySelector<HTMLElement>('[data-field="progress-resume-bar"]');
      if (label) label.textContent = `${progressTitle}：${summary.label} · ${progressRatioLabel(settled, total)}`;
      if (button) button.textContent = summary.finished ? '查看結果' : '查看進度';
      if (bar) bar.style.width = `${pct}%`;
    }
    el.innerHTML = `
      <div class="tr-progress-head">
        <span class="tr-progress-title">${escapeHtml(progressTitle)}</span>
        <span class="tr-progress-count">${progressRatioLabel(settled, total)}</span>
      </div>
      <div class="tr-progressbar tr-progressbar-${summary.tone}"><i style="width:${pct}%"></i></div>
      <ul class="tr-progress-list">
        ${progressRows.map(renderProgressRow).join('')}
      </ul>
      ${
        completionMessage
          ? `<div class="tr-upload-complete"><i class="fa-solid fa-circle-check"></i><b>${completionMessage}</b></div>`
          : ''
      }
    `;
    applyConnectionGuards();
  }

  function beginProgress(op: ProgressOp, title: string, rows: ProgressRow[]): boolean {
    if (blockNewProgressOperation()) {
      return false;
    }
    progressOp = op;
    progressTitle = title;
    progressRows = rows;
    progressRetryHandlers.clear();
    activeProgressTasks = 1;
    progressRunning = true;
    showScreen('progress');
    renderProgress();
    return true;
  }

  function beginProgressRetry(op: ProgressOp): boolean {
    if (progressOp !== op && !(op === 'backup' && progressOp === 'upload')) {
      setReport('這個重試已過期，請重新開始操作。');
      return false;
    }
    activeProgressTasks += 1;
    progressRunning = true;
    showScreen('progress');
    renderProgress();
    return true;
  }

  function finishProgressTask(): void {
    activeProgressTasks = Math.max(0, activeProgressTasks - 1);
    progressRunning = activeProgressTasks > 0;
    renderProgress();
  }

  function blockNewProgressOperation(): boolean {
    if (!progressRunning) return false;
    setReport('目前操作完成後，才能開始新的操作。');
    return true;
  }

  function showScreen(screen: PanelScreen): void {
    if (!root) {
      return;
    }
    if (screen === 'appearance' || currentScreen === 'appearance') {
      appearanceDraft = normalizeAppearance(options.getSettings().appearance);
      refreshAppearance();
      setText('appearance-feedback', '');
    }
    currentScreen = screen;
    for (const section of root.querySelectorAll<HTMLElement>('[data-screen]')) {
      section.hidden = section.dataset.screen !== screen;
    }
    root.querySelector<HTMLElement>('.tr-modal-content')?.scrollTo({ top: 0 });
    focusScreenHeading(screen);
  }

  function refreshAppearance(): void {
    if (!root) return;
    applyAppearance(root, appearanceDraft);
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-appearance]')) {
      const field = control.dataset.appearance;
      control.value = field === 'accentColor' ? appearanceDraft.accentColor ?? '#8aa8ff'
        : field === 'mode' ? appearanceDraft.mode : appearanceDraft.tone;
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-accent]')) {
      button.setAttribute('aria-pressed', String(button.dataset.accent === (appearanceDraft.accentColor ?? 'default')));
    }
    setText('appearance-color', appearanceDraft.accentColor ?? '主題預設');
  }

  function focusScreenHeading(screen: PanelScreen): void {
    const currentRoot = root;
    if (!currentRoot) return;
    const targetWindow = getHostDocument().defaultView ?? window;
    const focus = () => {
      if (root !== currentRoot) return;
      currentRoot
        .querySelector<HTMLElement>(`[data-screen="${screen}"] h2`)
        ?.focus({ preventScroll: true });
    };
    if (typeof targetWindow.requestAnimationFrame === 'function') {
      targetWindow.requestAnimationFrame(focus);
    } else {
      targetWindow.setTimeout(focus, 0);
    }
  }

  function bindDialogKeyboard(hostDocument: Document): void {
    const onKeydown = (event: KeyboardEvent) => {
      if (!root?.classList.contains('tr-floating') || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = root.querySelector<HTMLElement>('.tr-modal');
      if (!dialog) return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = hostDocument.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    hostDocument.addEventListener('keydown', onKeydown);
    removeKeyboardListener = () => hostDocument.removeEventListener('keydown', onKeydown);
  }

  async function showUploadConfirmation(): Promise<void> {
    const requestRevision = ++uploadPreviewRevision;
    pendingUploadPreparation = null;
    showScreen('upload-confirm');
    const preview = root?.querySelector<HTMLElement>('[data-field="upload-preview"]');
    const uploadButton = root?.querySelector<HTMLButtonElement>('[data-action="manual-upload"]');
    const environmentButton = root?.querySelector<HTMLButtonElement>('[data-action="upload-with-environment"]');
    if (!preview || !uploadButton || !environmentButton) {
      return;
    }
    uploadButton.disabled = true;
    environmentButton.disabled = true;
    environmentButton.hidden = true;
    preview.setAttribute('aria-busy', 'true');
    preview.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin"></i> 正在確認雲端聊天與環境備份…</div>';
    try {
      const preparation = await options.onPrepareChatUpload();
      if (requestRevision !== uploadPreviewRevision || currentScreen !== 'upload-confirm' || !root) return;
      pendingUploadPreparation = preparation;
      preview.innerHTML = renderChatUploadPreparationHtml(preparation);
      const needsEnvironmentDecision = preparation.recoveryStatus !== 'ready';
      environmentButton.hidden = !needsEnvironmentDecision;
      uploadButton.querySelector('span')!.textContent = needsEnvironmentDecision ? '只上傳聊天' : '確認上傳';
      applyConnectionGuards();
    } catch (error) {
      if (requestRevision !== uploadPreviewRevision || currentScreen !== 'upload-confirm') return;
      preview.innerHTML = `<div class="tr-callout tr-danger"><b>無法確認雲端檔案：</b>${escapeHtml(errorMessage(error))}</div>`;
      uploadButton.title = '確認雲端檔案失敗，請稍後再試';
    } finally {
      if (requestRevision === uploadPreviewRevision) preview.setAttribute('aria-busy', 'false');
    }
  }

  async function showRestorePoints(): Promise<void> {
    showScreen('restore-points');
    restorePointTarget = null;
    showRestorePointOverview();
    await loadRestorePointChats();
  }

  async function loadRestorePointChats(): Promise<void> {
    const requestRevision = ++restorePointLoadRevision;
    const list = root?.querySelector<HTMLElement>('[data-field="restore-chat-list"]');
    if (!list) return;
    beginRestorePointLoad();
    setRestorePointFeedback('');
    list.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> 正在建立全部 _pre_restore 索引…</div>';
    try {
      const chats = await options.onListRestorePointChats();
      if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points') return;
      restorePointChats = chats;
      renderRestorePointChats();
    } catch (error) {
      if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points') return;
      restorePointChats = [];
      list.innerHTML = `<div class="tr-callout tr-danger"><b>無法載入還原點</b><br />${escapeHtml(errorMessage(error))}</div>`;
    } finally {
      finishRestorePointLoad();
    }
  }

  function renderRestorePointChats(): void {
    const list = root?.querySelector<HTMLElement>('[data-field="restore-chat-list"]');
    if (!list) return;
    const query = root?.querySelector<HTMLInputElement>('[data-field="restore-search"]')?.value.trim().toLocaleLowerCase() ?? '';
    const sort = root?.querySelector<HTMLSelectElement>('[data-field="restore-sort"]')?.value ?? 'latest';
    const filtered = restorePointChats.filter(chat =>
      !query || chat.roleKey.toLocaleLowerCase().includes(query) || chat.chatId.toLocaleLowerCase().includes(query));
    filtered.sort((left, right) => {
      if (sort === 'oldest') return (left.latestCreatedAt ?? '').localeCompare(right.latestCreatedAt ?? '');
      if (sort === 'count') return right.batchCount - left.batchCount;
      if (sort === 'name') return left.roleKey.localeCompare(right.roleKey) || left.chatId.localeCompare(right.chatId);
      return (right.latestCreatedAt ?? '').localeCompare(left.latestCreatedAt ?? '');
    });
    list.innerHTML = renderRestorePointChatListHtml(filtered);
  }

  function showRestorePointOverview(): void {
    restorePointTarget = null;
    const overview = root?.querySelector<HTMLElement>('[data-field="restore-overview"]');
    const detail = root?.querySelector<HTMLElement>('[data-field="restore-detail"]');
    if (overview) overview.hidden = false;
    if (detail) detail.hidden = true;
    updateRestorePointSelection();
    root?.querySelector<HTMLInputElement>('[data-field="restore-search"]')?.focus({ preventScroll: true });
  }

  async function openRestorePointChat(target: RestorePointTarget): Promise<void> {
    restorePointTarget = target;
    const overview = root?.querySelector<HTMLElement>('[data-field="restore-overview"]');
    const detail = root?.querySelector<HTMLElement>('[data-field="restore-detail"]');
    if (overview) overview.hidden = true;
    if (detail) detail.hidden = false;
    setText('restore-detail-role', `角色：${target.roleKey}`);
    setText('restore-detail-chat', target.chatId);
    root?.querySelector<HTMLElement>('[data-field="restore-detail-chat"]')?.focus({ preventScroll: true });
    await loadRestorePointBatches(target);
  }

  async function loadRestorePointBatches(target = restorePointTarget): Promise<void> {
    if (!target) return;
    const requestRevision = ++restorePointLoadRevision;
    const list = root?.querySelector<HTMLElement>('[data-field="restore-point-list"]');
    if (!list) return;
    beginRestorePointLoad();
    setRestorePointFeedback('');
    list.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> 正在載入這個對話的完整 _pre_restore…</div>';
    try {
      const batches = await options.onListRestorePointBatches(target);
      if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points') return;
      restorePointBatches = batches;
      const available = new Set(batches.flatMap(batch => batch.files.map(file => file.fileId)));
      for (const [fileId, file] of selectedRestorePointFiles) {
        if (sameRestoreTarget(file, target) && !available.has(fileId)) selectedRestorePointFiles.delete(fileId);
      }
      list.innerHTML = renderRestorePointListHtml(batches, new Set(selectedRestorePointFiles.keys()));
      updateRestorePointSelection();
    } catch (error) {
      if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points') return;
      restorePointBatches = [];
      list.innerHTML = `<div class="tr-callout tr-danger"><b>無法載入還原點內容</b><br />${escapeHtml(errorMessage(error))}</div>`;
    } finally {
      finishRestorePointLoad();
    }
  }

  function updateRestorePointSelection(): void {
    if (!root) return;
    const files = [...root.querySelectorAll<HTMLInputElement>('[data-restore-file]')];
    const selected = files.filter(input => input.checked);
    const chatCount = new Set([...selectedRestorePointFiles.values()].map(file => JSON.stringify([file.roleKey, file.chatId]))).size;
    setText('restore-selection-count', `已選 ${selectedRestorePointFiles.size} 個檔案，來自 ${chatCount} 個對話`);
    const selectionBar = root.querySelector<HTMLElement>('[data-field="restore-selection"]');
    if (selectionBar) selectionBar.hidden = selectedRestorePointFiles.size === 0;
    const selectAll = root.querySelector<HTMLInputElement>('[data-action="select-all-restore-points"]');
    if (selectAll) {
      selectAll.checked = files.length > 0 && selected.length === files.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < files.length;
    }
    applyConnectionGuards();
  }

  async function mutateSelectedRestorePoints(permanent: boolean): Promise<void> {
    if (restorePointControlsBlocked()) return;
    const selected = [...selectedRestorePointFiles.values()];
    if (selected.length === 0) return;
    const summary = restorePointScopeSummary(selected);
    const verb = permanent ? '從 Google Drive 永久刪除' : '移到 Google Drive 垃圾桶';
    if (!confirmDestructive(`確定要${verb}已選內容嗎？\n\n${summary}\n\n${permanent ? '此操作無法復原。' : '之後仍可從 Drive 垃圾桶復原。'}`)) return;
    await runRestorePointMutation(
      selected,
      permanent ? options.onDeleteRestorePointFilesPermanently : options.onTrashRestorePointFiles,
      permanent ? '永久刪除' : '移到垃圾桶'
    );
  }

  async function cleanOldRestorePoints(days: 15 | 30, scope: 'all' | 'chat'): Promise<void> {
    if (!beginRestorePointDestructiveOperation()) return;
    const target = scope === 'chat' ? restorePointTarget ?? undefined : undefined;
    setRestorePointFeedback(`正在掃描${scope === 'all' ? '全部對話' : '這個對話'}中超過 ${days} 天的檔案…`);
    try {
      const preview = await options.onPreviewRestorePointCleanup(days, target);
      if (preview.targets.length === 0) {
        setRestorePointFeedback(`沒有放入 _pre_restore 超過 ${days} 天的檔案。`);
        return;
      }
      const summary = `${preview.targets.length} 個檔案 · ${preview.batchCount} 個批次 · ${preview.chatCount} 個對話 · ${preview.roleCount} 個角色`;
      if (!confirmDestructive(`已找到放入 _pre_restore 超過 ${days} 天的內容：\n\n${summary}\n\n確定要移到 Google Drive 垃圾桶嗎？`)) {
        setRestorePointFeedback('已取消清理，沒有改動任何檔案。');
        return;
      }
      await performRestorePointMutation(preview.targets, options.onTrashRestorePointFiles, '移到垃圾桶');
    } catch (error) {
      setRestorePointFeedback(`清理失敗：${errorMessage(error)}`, true);
    } finally {
      finishRestorePointDestructiveOperation();
    }
  }

  async function runRestorePointMutation(
    selections: RestorePointSelection[],
    operation: (files: RestorePointSelection[]) => ReturnType<PanelOptions['onTrashRestorePointFiles']>,
    actionLabel: string
  ): Promise<void> {
    if (!beginRestorePointDestructiveOperation()) return;
    try {
      await performRestorePointMutation(selections, operation, actionLabel);
    } finally {
      finishRestorePointDestructiveOperation();
    }
  }

  async function performRestorePointMutation(
    selections: RestorePointSelection[],
    operation: (files: RestorePointSelection[]) => ReturnType<PanelOptions['onTrashRestorePointFiles']>,
    actionLabel: string
  ): Promise<void> {
    setRestorePointFeedback(`正在${actionLabel}…`);
    try {
      const result = await operation(selections);
      const failedIds = new Set(result.failed.map(item => item.fileId));
      for (const selection of selections) {
        if (!failedIds.has(selection.fileId)) selectedRestorePointFiles.delete(selection.fileId);
      }
      await loadRestorePointChats();
      if (restorePointTarget) await loadRestorePointBatches(restorePointTarget);
      setRestorePointFeedback(result.failed.length === 0
        ? `已將 ${result.affected} 個遠端檔案${actionLabel}。`
        : `${result.affected} 個檔案已${actionLabel}，${result.failed.length} 個失敗。`, result.failed.length > 0);
    } catch (error) {
      setRestorePointFeedback(`${actionLabel}失敗：${errorMessage(error)}`, true);
    }
  }

  function beginRestorePointLoad(): void {
    activeRestorePointLoads += 1;
    applyConnectionGuards();
  }

  function finishRestorePointLoad(): void {
    activeRestorePointLoads = Math.max(0, activeRestorePointLoads - 1);
    applyConnectionGuards();
  }

  function beginRestorePointDestructiveOperation(): boolean {
    if (restorePointControlsBlocked()) return false;
    restorePointDestructiveOperationRunning = true;
    applyConnectionGuards();
    return true;
  }

  function finishRestorePointDestructiveOperation(): void {
    restorePointDestructiveOperationRunning = false;
    applyConnectionGuards();
  }

  function restorePointControlsBlocked(): boolean {
    return !driveState.connected || activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning;
  }

  function setRestorePointFeedback(message: string, error = false): void {
    const feedback = root?.querySelector<HTMLElement>('[data-field="restore-point-feedback"]');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle('tr-state-error', error);
  }

  function confirmDestructive(message: string): boolean {
    return (getHostDocument().defaultView ?? window).confirm(message);
  }

  /** 為指定 kinds 建立/重置進度列（重試時保留其他列）。 */
  function ensureRows(kinds: EnvironmentItemKind[]): void {
    for (const kind of kinds) {
      const existing = progressRows.find(row => row.key === kind);
      const fresh: ProgressRow = { key: kind, label: environmentLabel(kind), state: 'pending', detail: '等待中', canRetry: false };
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

  async function runBackup(kinds: EnvironmentItemKind[], retry = false): Promise<void> {
    if (retry) {
      if (!beginProgressRetry('backup')) return;
    } else if (!beginProgress('backup', '備份完整環境', [])) {
      return;
    }
    ensureRows(kinds);
    for (const kind of kinds) progressRetryHandlers.set(kind, () => { void runBackup([kind], true); });
    renderProgress();
    try {
      const results = await options.onBackupEnvironment(kinds, applyBackupEvent);
      applyBackupResults(results);
    } catch (error) {
      for (const kind of kinds) {
        patchRow(kind, { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
      }
    } finally {
      finishProgressTask();
    }
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

  function applyBackupResults(results: EnvironmentBackupViewResult[]): void {
    for (const result of results) {
      if (result.status === 'done') {
        patchRow(result.kind, { state: 'done', detail: result.filename ?? '完成', canRetry: false });
      } else {
        patchRow(result.kind, { state: 'error', detail: `失敗：${result.error ?? '未知錯誤'}`, canRetry: true });
      }
    }
  }

  async function runRestore(kinds: EnvironmentItemKind[], retry = false): Promise<void> {
    if (retry) {
      if (!beginProgressRetry('restore')) return;
    } else if (!beginProgress('restore', '還原環境', [])) {
      return;
    }
    ensureRows(kinds);
    for (const kind of kinds) progressRetryHandlers.set(kind, () => { void runRestore([kind], true); });
    renderProgress();
    try {
      const result = await options.onRestoreEnvironment(kinds, applyRestoreEvent);
      applyRestoreResults(result.items);
    } catch (error) {
      for (const kind of kinds) {
        patchRow(kind, { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
      }
    } finally {
      finishProgressTask();
    }
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
      const detail = {
        backup_current: '備份現況…',
        download: '下載中…',
        validate: '驗證中…',
        check_context: '核對操作對象…',
        apply: '套用中…',
        export: '匯出中…',
        upload: '上傳中…'
      }[event.step];
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

  function applyRestoreResults(items: EnvironmentRestoreViewResult['items']): void {
    for (const item of items) {
      if (item.status === 'done') {
        patchRow(item.kind, { state: 'done', detail: item.filename ?? '完成', canRetry: false });
      } else if (item.status === 'skipped') {
        patchRow(item.kind, { state: 'skipped', detail: '雲端無備份，略過', canRetry: false });
      } else if (item.status === 'aborted') {
        patchRow(item.kind, { state: 'aborted', detail: `已中止${item.error ? `：${item.error}` : ''}`, canRetry: true });
      } else {
        patchRow(item.kind, { state: 'error', detail: `失敗：${item.error ?? '未知錯誤'}`, canRetry: true });
      }
    }
  }

  async function runDownload(retry = false): Promise<void> {
    if (retry) {
      if (!beginProgressRetry('download')) return;
      patchRow('download', { state: 'active', detail: '正在建立還原點並更新…', canRetry: false });
    } else if (!beginProgress('download', '使用雲端最新版更新目前聊天', [{ key: 'download', label: '目前聊天', state: 'active', detail: '正在建立還原點並更新…', canRetry: false }])) {
      return;
    }
    progressRetryHandlers.set('download', () => { void runDownload(true); });
    try {
      const result = await options.onDownloadLatest();
      patchRow('download', {
        state: result.status === 'done' ? 'done' : 'warning',
        detail: result.detail,
        canRetry: false
      });
    } catch (error) {
      patchRow('download', { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
    } finally {
      finishProgressTask();
    }
  }

  async function runChatUpload(chatOnly: boolean): Promise<void> {
    if (blockNewProgressOperation()) return;
    const preparation = pendingUploadPreparation;
    if (!preparation) {
      setReport('上傳確認已過期，請重新進入上傳確認頁');
      return;
    }
    const selectedEnvironment = chatOnly
      ? []
      : collectEnvironmentSelection(root?.querySelector('[data-screen="upload-confirm"]'), 'chat-upload');
    if (!chatOnly && selectedEnvironment.length === 0) {
      setReport('請先勾選至少一個環境項目，或選擇「只上傳聊天」');
      return;
    }
    const characterAvailable = preparation.environment.find(item => item.kind === 'character')?.available ?? false;
    const leavesCharacterMissing = !characterAvailable && !selectedEnvironment.includes('character');
    if (leavesCharacterMissing) {
      const confirmed = confirmDestructive('這次不會備份角色卡，其他裝置可能無法建立這段聊天。確定繼續嗎？');
      if (!confirmed) return;
    }

    const rows: ProgressRow[] = [
      ...selectedEnvironment.map(kind => ({ key: kind, label: environmentLabel(kind), state: 'pending' as const, detail: '等待中', canRetry: false })),
      { key: 'upload', label: '目前聊天', state: 'pending', detail: '等待環境備份', canRetry: false }
    ];
    if (!beginProgress('upload', chatOnly ? '上傳目前聊天' : '備份環境並上傳聊天', rows)) return;
    pendingUploadPreparation = null;
    progressRetryHandlers.set('upload', () => { void showUploadConfirmation(); });
    for (const kind of selectedEnvironment) {
      progressRetryHandlers.set(kind, () => { void runBackup([kind], true); });
    }
    patchRow('upload', { state: selectedEnvironment.length ? 'pending' : 'active', detail: selectedEnvironment.length ? '等待環境備份' : '上傳中…' });
    try {
      const result = await options.onConfirmChatUpload({
        preparationId: preparation.preparationId,
        selectedEnvironment,
        chatOnly
      }, applyBackupEvent);
      applyBackupResults(result.environmentResults);
      if (!result.chat) {
        patchRow('upload', { state: 'aborted', detail: '角色卡備份失敗，已保留聊天未上傳', canRetry: true });
      } else if (result.chat.status === 'queued') {
        patchRow('upload', { state: 'queued', detail: result.chat.detail, canRetry: false });
      } else {
        patchRow('upload', { state: 'done', detail: result.chat.detail, canRetry: false });
      }
    } catch (error) {
      patchRow('upload', { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
    } finally {
      finishProgressTask();
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

  async function runPull(roleKey: string, chatId: string, retry = false): Promise<void> {
    if (retry) {
      if (!beginProgressRetry('pull')) return;
      patchRow('pull', { state: 'active', detail: '建立中…', canRetry: false });
    } else if (!beginProgress('pull', '從雲端建立聊天', [
      { key: 'pull', label: chatId, state: 'active', detail: '建立中…', canRetry: false }
    ])) {
      return;
    }
    progressRetryHandlers.set('pull', () => { void runPull(roleKey, chatId, true); });
    try {
      const result = await options.onPullChat(roleKey, chatId);
      patchRow('pull', {
        state: 'done',
        detail: `已建立 ${result.chatFileName}（來源 ${result.filename}）`,
        canRetry: false
      });
    } catch (error) {
      patchRow('pull', { state: 'error', detail: `失敗：${errorMessage(error)}`, canRetry: true });
    } finally {
      finishProgressTask();
    }
  }

  async function previewRestore(items: EnvironmentItemKind[]): Promise<void> {
    if (!root || restorePreviewLoading || blockNewProgressOperation()) {
      return;
    }
    pendingRestoreItems = items;
    restorePreviewReady = false;
    restorePreviewLoading = true;
    showScreen('restore-confirm');
    const preview = root.querySelector<HTMLElement>('[data-field="restore-preview"]');
    const retry = root.querySelector<HTMLButtonElement>('[data-action="retry-restore-preview"]');
    if (preview) {
      preview.setAttribute('aria-busy', 'true');
      preview.innerHTML = `<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin"></i> 正在檢查 ${items.length} 個項目的雲端備份…</div>`;
    }
    if (retry) {
      retry.disabled = true;
      retry.hidden = true;
    }
    applyConnectionGuards();
    try {
      const cloudFiles = await options.onPreviewRestore(items);
      if (!root) return;
      const currentPreview = root.querySelector<HTMLElement>('[data-field="restore-preview"]');
      if (currentPreview) currentPreview.innerHTML = renderRestorePreviewHtml(cloudFiles, items);
      restorePreviewReady = true;
    } catch (error) {
      if (!root) return;
      const currentPreview = root.querySelector<HTMLElement>('[data-field="restore-preview"]');
      const currentRetry = root.querySelector<HTMLButtonElement>('[data-action="retry-restore-preview"]');
      if (currentPreview) currentPreview.innerHTML = renderRestorePreviewErrorHtml(errorMessage(error));
      if (currentRetry) currentRetry.hidden = false;
    } finally {
      restorePreviewLoading = false;
      root?.querySelector<HTMLElement>('[data-field="restore-preview"]')?.setAttribute('aria-busy', 'false');
      applyConnectionGuards();
    }
  }

  function requestClose(): void {
    if (progressRunning) {
      const targetWindow = getHostDocument().defaultView ?? window;
      const confirmed = targetWindow.confirm('操作仍在進行中。關閉面板後會在背景繼續，稍後可重新開啟查看進度。確定關閉嗎？');
      if (!confirmed) return;
    }
    unmount();
    options.onClose?.();
  }

  async function runSystemCheck(mode: SelfCheckMode): Promise<void> {
    if (selfCheckRunning) return;
    if (mode === 'advanced') {
      const targetWindow = getHostDocument().defaultView ?? window;
      const confirmed = targetWindow.confirm(
        '進階診斷可能建立暫存角色卡或短暫修改專用測試聊天。請先停用自動同步，且只在測試資料上執行。確定繼續嗎？'
      );
      if (!confirmed) return;
    }
    selfCheckRunning = true;
    selfCheckMode = mode;
    selfCheckProgress = null;
    selfCheckResults = [];
    renderSelfCheckArea();
    try {
      selfCheckResults = await options.onRunSelfChecks(mode, progress => {
          selfCheckProgress = progress;
          if (progress.result) selfCheckResults = [...selfCheckResults, progress.result];
          renderSelfCheckArea();
        }
      );
    } catch (error) {
      setReport(`系統檢查失敗：${errorMessage(error)}`);
    } finally {
      selfCheckRunning = false;
      selfCheckProgress = null;
      renderSelfCheckArea();
    }
  }

  function renderSelfCheckArea(): void {
    const container = root?.querySelector<HTMLElement>('[data-field="self-check-results"]');
    if (!container) return;
    container.innerHTML = renderSelfCheckResultsHtml(selfCheckResults, {
      mode: selfCheckMode,
      running: selfCheckRunning,
      progress: selfCheckProgress
    });
    for (const button of root?.querySelectorAll<HTMLButtonElement>('[data-self-check-mode]') ?? []) {
      button.disabled = selfCheckRunning;
    }
  }

  async function copySelfCheckReport(): Promise<void> {
    if (selfCheckResults.length === 0) return;
    const clipboard = (getHostDocument().defaultView ?? window).navigator.clipboard;
    if (!clipboard?.writeText) {
      setReport('此瀏覽器無法直接複製，請展開各項「技術資訊」手動複製。');
      return;
    }
    try {
      await clipboard.writeText(buildSelfCheckReport(selfCheckResults));
      setReport('診斷報告已複製，敏感欄位已遮蔽');
    } catch (error) {
      setReport(`複製診斷報告失敗：${errorMessage(error)}`);
    }
  }

  function retryRow(key: string): void {
    progressRetryHandlers.get(key)?.();
  }

  // ── 事件綁定 ───────────────────────────────────────────────────

  function bindEvents(): void {
    if (!root) return;
    for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-external-link]')) {
      link.addEventListener('click', event => {
        // SillyTavern uses the surrounding drawer header as a collapse toggle.
        // Opening help must not also collapse the TavernRoamer panel.
        event.stopPropagation();
      });
    }
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-appearance]')) {
      const previewChange = () => {
        const field = control.dataset.appearance;
        if (field !== 'mode' && field !== 'tone' && field !== 'accentColor') return;
        appearanceDraft = normalizeAppearance({ ...appearanceDraft, [field]: control.value });
        refreshAppearance();
        setText('appearance-feedback', '預覽中，按「儲存外觀」保留變更。');
      };
      control.addEventListener('input', previewChange);
      control.addEventListener('change', previewChange);
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-accent]')) {
      button.addEventListener('click', () => {
        appearanceDraft = normalizeAppearance({ ...appearanceDraft, accentColor: button.dataset.accent });
        refreshAppearance();
        setText('appearance-feedback', '預覽中，按「儲存外觀」保留變更。');
      });
    }
    root.querySelector<HTMLButtonElement>('[data-action="reset-appearance"]')?.addEventListener('click', () => {
      appearanceDraft = { ...defaultAppearance };
      refreshAppearance();
      setText('appearance-feedback', '已預覽預設外觀，儲存後套用。');
    });
    root.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')?.addEventListener('click', () => {
      const saved = options.saveSettings({ ...options.getSettings(), appearance: appearanceDraft });
      options.onSave(saved);
      appearanceDraft = normalizeAppearance(saved.appearance);
      refreshAppearance();
      setText('appearance-feedback', '外觀已儲存。');
    });

    root.addEventListener('click', event => {
      if (event.target === root && root?.classList.contains('tr-floating')) {
        requestClose();
        return;
      }
      const navigation = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-navigate]');
      const screen = navigation?.dataset.navigate as PanelScreen | undefined;
      if (screen) {
        event.stopPropagation();
        if (screen === 'upload-confirm') {
          void showUploadConfirmation();
        } else if (screen === 'restore-points') {
          void showRestorePoints();
        } else {
          showScreen(screen);
        }
        return;
      }
      // 狀態卡的按鈕會隨 updateContext 重繪，因此以事件委派處理。
      const homeAction = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>('[data-action="refresh-status"], [data-action="flush-queue"]');
      if (!homeAction || homeAction.disabled) return;
      event.stopPropagation();
      if (homeAction.dataset.action === 'refresh-status') void refreshStatus();
      else void flushQueue();
    });

    root.querySelector<HTMLButtonElement>('[data-action="close-panel"]')?.addEventListener('click', event => {
      event.stopPropagation();
      requestClose();
    });

    root.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => {
      if (!root) return;
      const settings = collectSettings(root, options.getSettings());
      const saved = options.saveSettings(settings);
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
        const saved = options.saveSettings(collectSettings(root, options.getSettings()));
        options.onSave(saved);
        refreshSettingsGuidance(saved);
        const state = await options.onConnectDrive();
        updateDriveStatus(state);
        setReport(state.connected ? 'Google Drive 已連線' : `Google Drive 未連線：${state.error ?? '未知錯誤'}`);
        if (state.connected) {
          showScreen('home');
        }
      } catch (error) {
        updateDriveStatus({ connected: false, email: null, error: errorMessage(error) });
        setReport(errorMessage(error));
      }
    });

    root.querySelector<HTMLButtonElement>('[data-action="manual-upload"]')?.addEventListener('click', () => {
      void runChatUpload(true);
    });

    root.querySelector<HTMLButtonElement>('[data-action="upload-with-environment"]')?.addEventListener('click', () => {
      void runChatUpload(false);
    });

    root.querySelector<HTMLButtonElement>('[data-action="download-latest"]')?.addEventListener('click', () => {
      void runDownload();
    });

    root.querySelector<HTMLButtonElement>('[data-action="browse-cloud"]')?.addEventListener('click', () => {
      showScreen('cloud');
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
      lastPullTarget = { roleKey, chatId };
      setText('pull-role', roleKey);
      setText('pull-chat', chatId);
      showScreen('cloud-confirm');
    });

    root.querySelector<HTMLButtonElement>('[data-action="confirm-cloud-pull"]')?.addEventListener('click', async () => {
      if (lastPullTarget) {
        await runPull(lastPullTarget.roleKey, lastPullTarget.chatId);
      }
    });

    root.querySelector<HTMLButtonElement>('[data-action="backup-environment"]')?.addEventListener('click', () => {
      const selectedItems = collectEnvironmentSelection(root?.querySelector('[data-screen="environment-backup"]'), 'environment-backup');
      if (selectedItems.length === 0) {
        setReport('請先勾選至少一個環境項目');
        return;
      }
      void runBackup(selectedItems);
    });

    root.querySelector<HTMLButtonElement>('[data-action="restore-environment"]')?.addEventListener('click', async () => {
      const selectedItems = collectEnvironmentSelection(root?.querySelector('[data-screen="environment-restore"]'), 'environment-restore');
      if (selectedItems.length === 0) {
        setReport('請先勾選至少一個環境項目');
        return;
      }
      await previewRestore(selectedItems);
    });

    root.querySelector<HTMLButtonElement>('[data-action="retry-restore-preview"]')?.addEventListener('click', () => {
      void previewRestore(pendingRestoreItems);
    });

    root.querySelector<HTMLButtonElement>('[data-action="confirm-restore"]')?.addEventListener('click', () => {
      if (pendingRestoreItems.length > 0) {
        void runRestore(pendingRestoreItems);
      }
    });

    root.querySelector<HTMLButtonElement>('[data-action="refresh-restore-points"]')?.addEventListener('click', () => {
      if (restorePointTarget) void loadRestorePointBatches();
      else void loadRestorePointChats();
    });

    root.querySelector<HTMLInputElement>('[data-field="restore-search"]')?.addEventListener('input', renderRestorePointChats);
    root.querySelector<HTMLSelectElement>('[data-field="restore-sort"]')?.addEventListener('change', renderRestorePointChats);

    root.querySelector<HTMLElement>('[data-field="restore-chat-list"]')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-restore-chat]');
      const roleKey = button?.dataset.roleKey;
      const chatId = button?.dataset.chatId;
      if (roleKey && chatId) void openRestorePointChat({ roleKey, chatId });
    });

    root.querySelector<HTMLButtonElement>('[data-action="back-to-restore-chats"]')?.addEventListener('click', showRestorePointOverview);

    root.querySelector<HTMLInputElement>('[data-action="select-all-restore-points"]')?.addEventListener('change', event => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const available = new Map(restorePointBatches.flatMap(batch => batch.files).map(file => [file.fileId, file]));
      for (const input of root?.querySelectorAll<HTMLInputElement>('[data-restore-file]') ?? []) {
        input.checked = checked;
        const fileId = input.dataset.restoreFile;
        const file = fileId ? available.get(fileId) : undefined;
        if (!fileId) continue;
        if (checked && file) selectedRestorePointFiles.set(fileId, file);
        else selectedRestorePointFiles.delete(fileId);
      }
      updateRestorePointSelection();
    });

    root.querySelector<HTMLElement>('[data-field="restore-point-list"]')?.addEventListener('change', event => {
      const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('[data-restore-file]');
      const fileId = input?.dataset.restoreFile;
      if (!input || !fileId) return;
      const file = restorePointBatches.flatMap(batch => batch.files).find(item => item.fileId === fileId);
      if (input.checked && file) selectedRestorePointFiles.set(fileId, file);
      else selectedRestorePointFiles.delete(fileId);
      updateRestorePointSelection();
    });

    root.querySelector<HTMLButtonElement>('[data-action="trash-selected-restore-points"]')?.addEventListener('click', () => {
      void mutateSelectedRestorePoints(false);
    });

    root.querySelector<HTMLButtonElement>('[data-action="delete-selected-restore-points-permanently"]')?.addEventListener('click', () => {
      void mutateSelectedRestorePoints(true);
    });

    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-restore-age]')) {
      button.addEventListener('click', () => {
        const days = Number(button.dataset.restoreAge);
        const scope = button.dataset.restoreScope;
        if ((days === 15 || days === 30) && (scope === 'all' || scope === 'chat')) void cleanOldRestorePoints(days, scope);
      });
    }

    root.querySelector<HTMLButtonElement>('[data-self-check-mode="quick"]')?.addEventListener('click', () => {
      void runSystemCheck('quick');
    });

    root.querySelector<HTMLButtonElement>('[data-self-check-mode="advanced"]')?.addEventListener('click', () => {
      void runSystemCheck('advanced');
    });

    root.querySelector<HTMLElement>('[data-field="self-check-results"]')?.addEventListener('click', event => {
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-self-check-action]')
        ?.dataset.selfCheckAction;
      if (action === 'connect_drive') {
        root?.querySelector<HTMLButtonElement>('[data-action="connect-drive"]')?.click();
      } else if (action === 'open_settings') {
        showScreen('settings');
      } else if (action === 'copy_report') {
        void copySelfCheckReport();
      }
    });

    // 進度清單「重試」以事件委派處理（每次 renderProgress 會重寫 innerHTML）
    root.querySelector<HTMLElement>('[data-field="progress"]')?.addEventListener('click', event => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-retry-key]');
      const key = target?.getAttribute('data-retry-key');
      if (key) {
        retryRow(key);
      }
    });

  }

  /**
   * 所有需要 Drive 或受進度鎖影響的按鈕，停用狀態都只在這裡計算，
   * 避免某條路徑把其他條件要求停用的按鈕重新啟用。
   */
  function applyConnectionGuards(): void {
    if (!root) {
      return;
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-drive-required]')) {
      const reason = buttonBlockedReason(button);
      button.disabled = reason !== null;
      button.classList.toggle('tr-disabled', reason !== null);
      if (reason) button.title = reason;
      else button.removeAttribute('title');
    }
    const restorePointControlsDisabled = restorePointControlsBlocked();
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      '[data-restore-file], [data-restore-chat], [data-action="back-to-restore-chats"], [data-field="restore-search"], [data-field="restore-sort"]'
    )) {
      control.disabled = restorePointControlsDisabled;
    }
    const selectAll = root.querySelector<HTMLInputElement>('[data-action="select-all-restore-points"]');
    if (selectAll) {
      const hasFiles = root.querySelector('[data-restore-file]') !== null;
      selectAll.disabled = restorePointControlsDisabled || !hasFiles;
    }
    const restorePointBusy = activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning;
    root.querySelector<HTMLElement>('[data-field="restore-point-list"]')?.setAttribute('aria-busy', String(restorePointBusy));
    root.querySelector<HTMLElement>('[data-field="restore-chat-list"]')?.setAttribute('aria-busy', String(restorePointBusy));
  }

  /** 回傳停用原因；null 表示可用，空字串表示停用但不顯示提示。 */
  function buttonBlockedReason(button: HTMLButtonElement): string | null {
    const action = button.dataset.action ?? '';
    if (!driveState.connected) return DRIVE_GUARD_TITLE;
    const isSelectionAction = RESTORE_POINT_SELECTION_ACTIONS.has(action);
    if (isSelectionAction || button.hasAttribute('data-restore-age') || action === 'refresh-restore-points') {
      // 還原點管理不受進度鎖影響，只看自己的忙碌狀態與選取數量。
      if (activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning) return '正在處理還原點，請稍候';
      if (isSelectionAction && selectedRestorePointFiles.size === 0) return '請先勾選還原點檔案';
      return null;
    }
    if (action === 'refresh-status' && statusRefreshRunning) return '';
    if (action === 'flush-queue' && queueFlushRunning) return '';
    if (progressRunning && (button.hasAttribute('data-home-task') || PROGRESS_START_ACTIONS.has(action))) {
      return PROGRESS_LOCK_TITLE;
    }
    if (action === 'confirm-restore' && (!restorePreviewReady || restorePreviewLoading)) return '請先完成雲端備份檢查';
    if (action === 'retry-restore-preview' && restorePreviewLoading) return '';
    if ((action === 'manual-upload' || action === 'upload-with-environment') && !pendingUploadPreparation) {
      return '請先完成上傳前檢查';
    }
    return null;
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

  function setText(field: string, value: string): void {
    for (const el of root?.querySelectorAll<HTMLElement>(`[data-field="${field}"]`) ?? []) {
      el.textContent = value;
    }
  }

  function setReport(text: string): void {
    const report = root?.querySelector<HTMLElement>('[data-field="report"]');
    if (report) {
      report.textContent = text;
    }
  }

  return { mount, unmount, updateContext, updateDriveStatus, invalidateUploadPreparation, probe };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRestoreTarget(left: RestorePointTarget, right: RestorePointTarget): boolean {
  return left.roleKey === right.roleKey && left.chatId === right.chatId;
}

function restorePointScopeSummary(files: readonly RestorePointFile[]): string {
  const roles = new Set(files.map(file => file.roleKey)).size;
  const chats = new Set(files.map(file => JSON.stringify([file.roleKey, file.chatId]))).size;
  const batches = new Set(files.map(file => file.batchFolderId)).size;
  return `${files.length} 個檔案 · ${batches} 個批次 · ${chats} 個對話 · ${roles} 個角色`;
}

function collectSettings(root: HTMLElement, current: Settings): Settings {
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

function progressSummaryIcon(tone: ProgressSummary['tone']): string {
  switch (tone) {
    case 'running':
      return '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    case 'success':
      return '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>';
    case 'warning':
      return '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
    case 'error':
      return '<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>';
    case 'neutral':
    default:
      return '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>';
  }
}

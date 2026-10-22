import type { EnvironmentItemKind } from '../../environment/types';
import { formatLastSyncedLabel, formatLocalMinute, formatLocalTime, parseVersionFilename } from '../../drive/version';
import type { RestorePointBatch, RestorePointChatSummary, RestorePointFile, RestorePointFileKind } from '../../restorePoints/types';
import type { DriveConnectionState, PanelStatusInfo, Settings, SyncStatus, TavernContext } from '../../types';
import { formatAutoSyncLabel, formatPendingLabel, statusPill } from '../formatters';
import { escapeAttribute, escapeHtml } from '../html';
import type { ChatUploadPreparationView, CloudChatViewEntry, CloudRoleViewEntry } from '../types';
import { accentPresets, normalizeAppearance } from '../appearance';
import { ENVIRONMENT_ITEM_ORDER, environmentLabel } from '../environmentPresentation';
import { defaultEnvironmentChoices, renderEnvironmentChoices, type EnvironmentChoiceView } from '../environmentSelection';
import { chatSummary, iconButton, stepFooter, stepHeading, type PanelScreen } from './shared';

const TUTORIAL_SITE_URL = 'https://twinklestars1029.github.io/TavernRoamer-website/';
const GOOGLE_SETUP_GUIDE_URL = `${TUTORIAL_SITE_URL}setup/google-oauth/`;
const GOOGLE_SETUP_GITHUB_URL = 'https://github.com/TwinkleStars1029/TavernRoamer/blob/main/docs/gcp-setup.md';

export function renderPanel(
  settings: Settings,
  context: TavernContext,
  driveState: DriveConnectionState,
  floating = false,
  progressRunning = false,
  homeStatusInfo: PanelStatusInfo = { lastSyncedVersion: null, pendingUploads: 0 }
): string {
  const pill = statusPill(context.status);
  return `
    <div class="inline-drawer ${floating ? 'tr-modal' : ''}" ${floating ? 'role="dialog" aria-modal="true" aria-labelledby="tavern-roamer-dialog-title" tabindex="-1"' : ''}>
      <div class="inline-drawer-toggle inline-drawer-header ${floating ? 'tr-modal-header' : ''}">
        ${
          floating
            ? '<div><div class="tr-kicker">TavernRoamer</div><b class="tr-title" id="tavern-roamer-dialog-title">雲端漫遊</b></div>'
            : '<b>TavernRoamer</b>'
        }
        <div class="tr-header-actions">
          <button type="button" class="menu_button tr-icon-button" data-navigate="home" title="回到首頁" aria-label="首頁"><i class="fa-solid fa-house" aria-hidden="true"></i><span>首頁</span></button>
          <button type="button" class="menu_button tr-icon-button" data-navigate="appearance" title="外觀設定" aria-label="樣式"><i class="fa-solid fa-palette" aria-hidden="true"></i><span>樣式</span></button>
          <button type="button" class="menu_button tr-connection-button" data-navigate="settings" title="前往連線設定"><i class="tr-connection-dot ${driveState.connected ? 'is-connected' : ''}" data-field="drive-connection-dot" aria-hidden="true"></i><span data-field="drive-identity">${escapeHtml(driveState.connected ? driveState.email ?? '已連線' : '未連線')}</span></button>
          ${
            floating
              ? '<button type="button" class="menu_button tr-close" data-action="close-panel">關閉</button>'
              : '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'
          }
        </div>
      </div>
      <div class="inline-drawer-content ${floating ? 'tr-modal-content' : ''}">
        <div class="tr-body">

          <section class="tr-screen" data-screen="home" aria-labelledby="tr-screen-home-title">
            <h2 class="tr-visually-hidden" id="tr-screen-home-title" tabindex="-1">雲端漫遊首頁</h2>
            <div class="tr-current-card" data-field="home-current" ${driveState.connected ? '' : 'hidden'}>
              <div class="tr-operation-banner" data-field="progress-resume" hidden>
                <div class="tr-operation-summary"><i class="fa-solid fa-bars-progress" aria-hidden="true"></i><b data-field="progress-resume-label">操作進度</b></div>
                <div class="tr-progressbar tr-progress-resume-bar"><i data-field="progress-resume-bar"></i></div>
                <button type="button" class="menu_button" data-navigate="progress" data-field="progress-resume-action">查看進度</button>
              </div>
              <div data-field="home-current-content">
                ${renderHomeCurrentContent(settings, context, homeStatusInfo, driveState.connected, progressRunning)}
              </div>
            </div>
            <div class="tr-connect-guide" data-field="home-disconnected" ${driveState.connected ? 'hidden' : ''}>
              <div class="tr-connect-guide-head"><i class="fa-solid fa-cloud" aria-hidden="true"></i><div><h3>連線 Google Drive 後就能開始同步</h3><p>只需設定一次，之後每台裝置都連同一個 Drive。</p></div></div>
              <ol class="tr-connect-steps">
                <li><span>1</span><div><b>建立 Google Client ID</b><a class="tr-help-link" data-external-link href="${GOOGLE_SETUP_GITHUB_URL}" target="_blank" rel="noopener noreferrer">設定教學 <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="tr-visually-hidden">（新分頁）</span></a></div></li>
                <li><span>2</span><div><b>在設定頁填入並連線</b></div></li>
              </ol>
              <button type="button" class="menu_button ${driveState.connected ? '' : 'tr-primary'}" data-field="home-connect-primary" data-navigate="settings">前往連線</button>
            </div>
            <div class="tr-home-actions" data-field="home-actions" ${driveState.connected ? '' : 'hidden'}>
              <section class="tr-task-section" aria-labelledby="tr-chat-tasks-title">
                <div class="tr-task-section-head"><h3 id="tr-chat-tasks-title">聊天</h3></div>
                <div class="tr-task-grid tr-task-grid-chat">
                  ${taskButton('upload-confirm', 'fa-cloud-arrow-up', '上傳目前聊天', '存到雲端', false, progressRunning)}
                  ${taskButton('download-confirm', 'fa-rotate', '用雲端版更新', '先建立還原點', false, progressRunning)}
                  ${taskButton('browse-cloud', 'fa-cloud-arrow-down', '從雲端建立聊天', '帶回其他聊天', true, progressRunning)}
                </div>
              </section>
              <section class="tr-task-section" aria-labelledby="tr-environment-tasks-title">
                <div class="tr-task-section-head"><h3 id="tr-environment-tasks-title">酒館環境</h3></div>
                <div class="tr-environment-actions">
                  ${secondaryTaskButton('environment-backup', 'fa-box-archive', '備份環境', progressRunning)}
                  ${secondaryTaskButton('environment-restore', 'fa-box-open', '還原環境', progressRunning)}
                  ${secondaryTaskButton('restore-points', 'fa-clock-rotate-left', '管理還原點', progressRunning)}
                </div>
              </section>
              <p class="tr-home-progress-lock" data-field="home-progress-lock" role="status" ${progressRunning ? '' : 'hidden'}>目前操作完成後，才能開始新的操作。</p>
            </div>
          </section>

          <section class="tr-screen" data-screen="upload-confirm" aria-labelledby="tr-screen-upload-confirm-title" hidden>${stepHeading('upload-confirm', '確認', '確認上傳', '確認目前聊天、雲端版本與遠端使用所需環境。')}<div class="tr-upload-overview">${chatSummary(context, pill)}<div data-field="upload-preview"><div class="tr-callout">正在確認雲端聊天與環境備份…</div></div></div>${stepFooter('home', `${iconButton('upload-with-environment', 'fa-box-archive', '備份所選環境並上傳', true, true)}${iconButton('manual-upload', 'fa-upload', '確認上傳', true)}`)}</section>
          <section class="tr-screen" data-screen="download-confirm" aria-labelledby="tr-screen-download-confirm-title" hidden>${stepHeading('download-confirm', '確認', '確認更新目前聊天', '將使用雲端最新版更新目前聊天。')}${chatSummary(context, pill)}<div class="tr-callout tr-danger" data-field="download-conflict-warning" ${context.status === 'conflict' ? '' : 'hidden'}><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 本機有尚未上傳的變更，更新後只能從雲端還原點找回。</div><div class="tr-callout tr-danger"><b>更新方式：</b>系統會先將目前聊天保存成雲端還原點，再以雲端最新版取代目前內容。</div>${stepFooter('home', iconButton('download-latest', 'fa-rotate', '確認更新', true))}</section>
          <section class="tr-screen" data-screen="cloud" aria-labelledby="tr-screen-cloud-title" hidden>${stepHeading('cloud', '選擇', '選擇雲端聊天', '先選角色，再選擇要帶回本地的聊天。')}<div class="tr-cloud" data-field="cloud-list"><p class="tr-cloud-empty">載入中…</p></div>${stepFooter('home', '')}</section>
          <section class="tr-screen" data-screen="cloud-confirm" aria-labelledby="tr-screen-cloud-confirm-title" hidden>${stepHeading('cloud-confirm', '確認', '確認建立聊天', '將從雲端內容在本地建立一份新聊天。')}<div class="tr-summary-card"><div><span>角色</span><b data-field="pull-role">—</b></div><div><span>聊天 ID</span><b data-field="pull-chat">—</b></div></div><div class="tr-callout">若本地沒有這張角色卡，會先嘗試從雲端還原角色卡。</div>${stepFooter('cloud', iconButton('confirm-cloud-pull', 'fa-cloud-arrow-down', '建立本地聊天', true))}</section>
          <section class="tr-screen" data-screen="environment-backup" aria-labelledby="tr-screen-environment-backup-title" hidden>${stepHeading('environment-backup', '選擇', '選擇備份內容', '勾選要保存到雲端的酒館資料。')}${renderEnvironmentChoices('environment-backup', defaultEnvironmentChoices())}<div class="tr-callout">每個項目都會建立新版本，既有備份會保留。</div>${stepFooter('home', iconButton('backup-environment', 'fa-box-archive', '開始備份', true))}</section>
          <section class="tr-screen" data-screen="environment-restore" aria-labelledby="tr-screen-environment-restore-title" hidden>${stepHeading('environment-restore', '選擇', '選擇還原內容', '下一步會先檢查雲端備份，再讓你確認。')}${renderEnvironmentChoices('environment-restore', defaultEnvironmentChoices())}${stepFooter('home', iconButton('restore-environment', 'fa-arrow-right', '預覽還原內容', true))}</section>
          <section class="tr-screen" data-screen="restore-confirm" aria-labelledby="tr-screen-restore-confirm-title" hidden>${stepHeading('restore-confirm', '確認', '確認還原內容', '套用前會先備份本機現況。')}<div class="tr-restore-preview" data-field="restore-preview" role="status" aria-live="polite" aria-busy="false"></div><button type="button" class="menu_button tr-preview-retry" data-action="retry-restore-preview" data-drive-required hidden><i class="fa-solid fa-rotate-right"></i><span>重新檢查</span></button><div class="tr-callout tr-danger">只有成功確認到雲端備份的項目才會開放還原。</div>${stepFooter('environment-restore', iconButton('confirm-restore', 'fa-box-open', '確認還原', true))}</section>
          <section class="tr-screen" data-screen="restore-points" aria-labelledby="tr-screen-restore-points-title" hidden>
            ${stepHeading('restore-points', '管理', '雲端還原點', '先選角色與對話，再查看該對話完整的 _pre_restore 內容。')}
            <div class="tr-restore-toolbar">
              <label class="tr-field"><span>搜尋角色或對話</span><input type="search" class="text_pole" data-field="restore-search" placeholder="輸入名稱" /></label>
              <label class="tr-field"><span>排序</span><select class="text_pole" data-field="restore-sort"><option value="latest">最新還原點</option><option value="oldest">最舊還原點</option><option value="count">批次數量</option><option value="name">角色 / 對話名稱</option></select></label>
              <button type="button" class="menu_button" data-action="refresh-restore-points" data-drive-required><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>重新整理</span></button>
            </div>
            <div class="tr-restore-selection" data-field="restore-selection" hidden>
              <span data-field="restore-selection-count" aria-live="polite">已選 0 個檔案</span>
              <button type="button" class="menu_button" data-action="trash-selected-restore-points" data-drive-required disabled><i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>移到 Drive 垃圾桶</span></button>
              <details class="tr-restore-advanced"><summary>進階操作</summary><button type="button" class="menu_button tr-danger-button" data-action="delete-selected-restore-points-permanently" data-drive-required disabled><i class="fa-solid fa-trash" aria-hidden="true"></i><span>永久刪除已選</span></button></details>
            </div>
            <p class="tr-restore-point-feedback" data-field="restore-point-feedback" role="status" aria-live="polite"></p>
            <div data-field="restore-overview">
              <div class="tr-restore-cleanup-card">
                <div><b>全部對話清理</b><small>會先掃描全部 _pre_restore 並顯示影響範圍，確認後才移到垃圾桶。</small></div>
                <div class="tr-restore-point-actions"><button type="button" class="menu_button" data-restore-age="15" data-restore-scope="all" data-drive-required><i class="fa-solid fa-calendar-xmark" aria-hidden="true"></i><span>清理超過 15 天</span></button><button type="button" class="menu_button" data-restore-age="30" data-restore-scope="all" data-drive-required><i class="fa-solid fa-calendar-xmark" aria-hidden="true"></i><span>清理超過 30 天</span></button></div>
              </div>
              <div class="tr-restore-chat-list" data-field="restore-chat-list" aria-busy="false"><p class="tr-cloud-empty">尚未載入。</p></div>
            </div>
            <div data-field="restore-detail" hidden>
              <button type="button" class="menu_button tr-back-inline" data-action="back-to-restore-chats"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>回到對話清單</span></button>
              <div class="tr-restore-detail-head"><div><small data-field="restore-detail-role">角色</small><h3 data-field="restore-detail-chat" tabindex="-1">對話</h3></div><div class="tr-restore-point-actions"><button type="button" class="menu_button" data-restore-age="15" data-restore-scope="chat" data-drive-required><span>清理超過 15 天</span></button><button type="button" class="menu_button" data-restore-age="30" data-restore-scope="chat" data-drive-required><span>清理超過 30 天</span></button></div></div>
              <div class="tr-restore-detail-select"><label><input type="checkbox" data-action="select-all-restore-points" /><span>全選這個對話的檔案</span></label></div>
              <div class="tr-restore-point-list" data-field="restore-point-list" aria-busy="false"><p class="tr-cloud-empty">請選擇對話。</p></div>
            </div>
            ${stepFooter('home', '')}
          </section>
          <section class="tr-screen" data-screen="progress" aria-labelledby="tr-screen-progress-title" hidden>${stepHeading('progress', '執行', '執行進度', '你可以回到首頁，稍後再開啟此頁查看狀態。')}<div class="tr-progress-state tr-state-running" data-field="progress-state-wrap" role="status" aria-live="polite"><i class="fa-solid fa-spinner fa-spin"></i><b data-field="progress-state">正在處理</b></div><div class="tr-progress" data-field="progress" aria-live="polite" hidden></div><div class="tr-step-footer"><button type="button" class="menu_button" data-navigate="home">回到首頁</button></div></section>
          <section class="tr-screen" data-screen="settings" aria-labelledby="tr-screen-settings-title" hidden>${stepHeading('settings', '設定', '連線與同步設定', '設定 Google Drive 與這台裝置的同步方式。')}<div class="tr-settings-content">
            <p class="tr-guidance" data-field="guidance" ${settings.googleClientId.trim() ? 'hidden' : ''}>第一次使用請填入 Google Client ID，再按「連線 Google Drive」。</p>
            <label class="tr-field"><span>Google Client ID</span><input class="text_pole" data-input="googleClientId" value="${escapeAttribute(settings.googleClientId)}" autocomplete="off" /></label>
            <a class="tr-help-link" data-external-link href="${GOOGLE_SETUP_GUIDE_URL}" target="_blank" rel="noopener noreferrer">如何取得 Google Client ID？ <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="tr-visually-hidden">（新分頁）</span></a>
            <label class="tr-field"><span>裝置名稱</span><input class="text_pole" data-input="deviceName" value="${escapeAttribute(settings.deviceName)}" autocomplete="off" /></label>
            <label class="tr-field tr-inline"><span>自動同步每 N 則</span><input class="text_pole" data-input="autoSyncEveryN" type="number" min="1" step="1" value="${settings.autoSyncEveryN}" /></label>
            <label class="checkbox_label"><input data-input="autoSyncEnabled" type="checkbox" ${settings.autoSyncEnabled ? 'checked' : ''} /><span>啟用自動同步</span></label>
            <div class="tr-actions">${iconButton('connect-drive', 'fa-plug', '連線 Google Drive')} ${iconButton('save', 'fa-save', '儲存設定')}</div>
            <div class="tr-self-check-panel">
              <div class="tr-self-check-head"><div><b>系統檢查</b><small>快速檢查不會改動聊天、角色卡或環境資料；Drive 測試只建立並清理暫存檔。</small></div><div class="tr-actions"><button type="button" class="menu_button" data-self-check-mode="quick"><i class="fa-solid fa-stethoscope"></i><span>快速檢查</span></button><button type="button" class="menu_button" data-self-check-mode="advanced"><i class="fa-solid fa-flask"></i><span>進階診斷</span></button></div></div>
              <div class="tr-self-check-results" data-field="self-check-results" aria-live="polite"></div>
            </div>
          </div>${stepFooter('home', '')}</section>
          <section class="tr-screen" data-screen="appearance" aria-labelledby="tr-screen-appearance-title" hidden>${stepHeading('appearance', '設定', '外觀設定', '調整雲端漫遊所有頁面的配色；下方變更會即時預覽，儲存後保留。')}${appearanceControls(settings)}${stepFooter('home', iconButton('save-appearance', 'fa-save', '儲存外觀'))}</section>

          <pre data-field="report" class="tr-report" aria-live="polite"></pre>
        </div>
      </div>
    </div>
  `;
}

function appearanceControls(settings: Settings): string {
  const appearance = normalizeAppearance(settings.appearance);
  const choices = (values: readonly (readonly [string, string])[], selected: string) => values
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  return `<div class="tr-appearance-controls">
    <label class="tr-field"><span>主題模式</span><select class="text_pole" data-appearance="mode">${choices([['tavern', '跟隨酒館'], ['light', '淺色'], ['dark', '深色']], appearance.mode)}</select></label>
    <fieldset class="tr-fieldset"><legend>強調色</legend><div class="tr-accent-presets">
      <button type="button" class="menu_button" data-accent="default" aria-pressed="${appearance.accentColor === null}">主題預設</button>
      ${accentPresets.map(preset => `<button type="button" class="menu_button tr-swatch" data-accent="${preset.color}" style="--tr-swatch: ${preset.color}" aria-pressed="${appearance.accentColor === preset.color}"><i aria-hidden="true"></i><span>${preset.name}</span></button>`).join('')}
    </div><label class="tr-color-field"><span>自訂顏色</span><input type="color" data-appearance="accentColor" value="${appearance.accentColor ?? '#8aa8ff'}" /><span data-field="appearance-color">${appearance.accentColor ?? '主題預設'}</span></label></fieldset>
    <label class="tr-field"><span>色調</span><select class="text_pole" data-appearance="tone">${choices([['soft', '柔和'], ['standard', '標準'], ['vivid', '鮮明']], appearance.tone)}</select><small class="tr-muted">調整卡片背景與邊框的強度。</small></label>
    <div class="tr-appearance-preview tr-summary-card"><div><span>配色預覽</span><b>標題與內文</b><small class="tr-muted">次要說明文字</small></div><div><span>操作與狀態</span><button type="button" class="menu_button tr-primary" disabled>主要按鈕</button><div class="tr-preview-statuses"><span class="tr-state-success">成功</span><span class="tr-state-warning">警告</span><span class="tr-state-error">錯誤</span></div></div></div>
    <p class="tr-muted">成功、警告與錯誤保留辨識色。返回上一頁會取消尚未儲存的變更。</p>
    <div class="tr-actions">${iconButton('reset-appearance', 'fa-rotate-left', '重設為跟隨酒館')}</div>
    <p data-field="appearance-feedback" role="status" aria-live="polite"></p>
  </div>`;
}

export function renderHomeCurrentContent(
  settings: Settings,
  context: TavernContext,
  info: PanelStatusInfo,
  driveConnected: boolean,
  progressRunning: boolean
): string {
  const pill = statusPill(context.status);
  return `
    <div class="tr-current-main">
      <div class="tr-current-avatar" data-field="home-current-avatar" aria-hidden="true">${renderHomeCurrentAvatar(context)}</div>
      <div class="tr-current-details">
        <b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b>
        <span class="tr-current-filename" data-field="chat-file" title="${escapeAttribute(context.chatFileName ?? '未開啟聊天')}">${escapeHtml(context.chatFileName ?? '未開啟聊天')}</span>
        <div class="tr-current-status" role="status" aria-live="polite">
          <b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b>
          <p class="tr-current-meta" data-field="home-current-meta">${renderHomeCurrentMeta(settings, info)}</p>
          <p class="tr-current-feedback" data-field="home-current-feedback"></p>
        </div>
      </div>
      <div class="tr-current-cta" data-field="home-current-cta">${renderHomeCurrentAction(context, driveConnected, progressRunning)}</div>
    </div>
  `;
}

export function renderHomeCurrentAvatar(context: TavernContext): string {
  const initial = Array.from(context.characterName?.trim() ?? '')[0];
  return initial ? escapeHtml(initial) : '<i class="fa-solid fa-user" aria-hidden="true"></i>';
}

export function renderHomeCurrentMeta(settings: Settings, info: PanelStatusInfo, flushing = false): string {
  const pending = formatPendingLabel(info.pendingUploads);
  const flushButton = `<button type="button" class="menu_button tr-queue-flush${flushing ? ' tr-disabled' : ''}" data-field="home-flush-queue" data-action="flush-queue" data-drive-required data-home-task${flushing ? ' aria-busy="true" disabled' : ''}><i class="fa-solid ${flushing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'}" aria-hidden="true"></i><span>${flushing ? '補傳中…' : '立即補傳'}</span></button>`;
  return `<span>最後同步 <b data-field="last-synced">${escapeHtml(formatLastSyncedLabel(info.lastSyncedVersion))}</b></span><span>自動同步 <b data-field="auto-sync">${escapeHtml(formatAutoSyncLabel(settings))}</b></span>${pending.visible ? `<span data-field="queue-segment"><b data-field="queue">${escapeHtml(pending.text)}</b>${flushButton}</span>` : ''}`;
}

type HomeCurrentActionView = {
  /** data-navigate 目的地，或 data-action 名稱（以 action: 前綴區分）。 */
  target: 'upload-confirm' | 'download-confirm' | 'action:refresh-status';
  icon: string;
  label: string;
  note: string | null;
};

const UPLOAD_ACTION = { target: 'upload-confirm', icon: 'fa-cloud-arrow-up', label: '上傳目前聊天' } as const;
const REUPLOAD_ACTION = { target: 'upload-confirm', icon: 'fa-cloud-arrow-up', label: '重新上傳' } as const;
const REFRESH_ACTION = { target: 'action:refresh-status', icon: 'fa-rotate-right', label: '重新檢查' } as const;

/** 每個同步狀態對應的唯一主要下一步；null 表示不需要動作（conflict 另外處理）。 */
const HOME_CURRENT_ACTIONS: Record<Exclude<SyncStatus, 'conflict'>, HomeCurrentActionView | null> = {
  local_dirty: { ...UPLOAD_ACTION, note: null },
  newer_remote: { target: 'download-confirm', icon: 'fa-rotate', label: '用雲端版更新', note: '更新前會先建立還原點' },
  untracked: { ...UPLOAD_ACTION, note: '第一次上傳會建立雲端版本' },
  remote_available: { ...UPLOAD_ACTION, note: '雲端已有這段聊天的版本，上傳會新增一份；要改用雲端內容請用下方「用雲端版更新」' },
  remote_missing: { ...REUPLOAD_ACTION, note: '雲端找不到上次同步的版本' },
  remote_mismatch: { ...REUPLOAD_ACTION, note: '雲端最新版比上次同步的還舊，可能被清理過' },
  check_failed: { ...REFRESH_ACTION, note: '無法連到雲端核對' },
  unknown: { ...REFRESH_ACTION, note: '尚未核對雲端版本' },
  synced: null,
  not_connected: null
};

/** 首頁狀態卡的唯一主要下一步；狀態改變時只重繪這一塊，live region 本身保持不變。 */
export function renderHomeCurrentAction(
  context: TavernContext,
  driveConnected: boolean,
  progressRunning: boolean,
  refreshing = false
): string {
  const hasChat = Boolean(context.characterName?.trim() && context.chatFileName?.trim());
  const disabled = progressRunning || !driveConnected;

  if (!hasChat) {
    return '<p class="tr-current-empty"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>請先在酒館開啟一段聊天</span></p>';
  }
  if (context.status === 'conflict') {
    return `<div class="tr-current-action tr-current-conflict"><p class="tr-current-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>兩台裝置都改過這段聊天，請選擇要保留哪一邊。</span></p>${homeCurrentButton('home-current-conflict-upload', 'data-navigate="upload-confirm"', 'fa-cloud-arrow-up', '上傳本機版本', false, disabled)}${homeCurrentButton('home-current-conflict-download', 'data-navigate="download-confirm"', 'fa-rotate', '改用雲端版', false, disabled)}</div>`;
  }
  const action = HOME_CURRENT_ACTIONS[context.status];
  if (!action) return '';
  const isRefresh = action.target === 'action:refresh-status';
  const destination = isRefresh ? 'data-action="refresh-status"' : `data-navigate="${action.target}"`;
  const busy = isRefresh && refreshing;
  const button = homeCurrentButton(
    'home-current-primary',
    destination,
    action.icon,
    busy ? '檢查中…' : action.label,
    driveConnected,
    disabled || busy,
    busy
  );
  return action.note
    ? `<div class="tr-current-action">${button}<small>${escapeHtml(action.note)}</small></div>`
    : button;
}

function homeCurrentButton(
  field: string,
  destination: string,
  icon: string,
  label: string,
  primary: boolean,
  disabled: boolean,
  busy = false
): string {
  const buttonClass = `${primary ? ' tr-primary' : ''}${disabled ? ' tr-disabled' : ''}`;
  return `<button type="button" class="menu_button${buttonClass}" data-field="${field}" ${destination} data-drive-required data-home-task${busy ? ' aria-busy="true"' : ''}${disabled ? ' disabled' : ''}><i class="fa-solid ${busy ? 'fa-spinner fa-spin' : icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
}

function taskButton(
  target: PanelScreen | 'browse-cloud',
  icon: string,
  title: string,
  description: string,
  action = false,
  disabled = false
): string {
  const destination = action ? `data-action="${target}"` : `data-navigate="${target}"`;
  return `<button type="button" class="tr-task-card${disabled ? ' tr-disabled' : ''}" ${destination} data-drive-required data-home-task${disabled ? ' disabled' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span><b>${title}</b><small>${description}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
}

function secondaryTaskButton(target: PanelScreen, icon: string, title: string, disabled = false): string {
  return `<button type="button" class="menu_button tr-secondary-task${disabled ? ' tr-disabled' : ''}" data-navigate="${target}" data-drive-required data-home-task${disabled ? ' disabled' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${title}</span></button>`;
}

export function renderRestorePreviewHtml(
  cloudFiles: Partial<Record<EnvironmentItemKind, string | null>>,
  selectedItems: readonly EnvironmentItemKind[] = ENVIRONMENT_ITEM_ORDER
): string {
  const overwrite = selectedItems.filter(kind => Boolean(cloudFiles[kind]));
  const skipped = selectedItems.filter(kind => !cloudFiles[kind]);
  const ready = overwrite.length > 0
    ? overwrite
        .map(kind => `<div class="tr-preview-row"><i class="fa-solid fa-cloud-arrow-down"></i><span><b>${environmentLabel(kind)}</b><small class="tr-preview-filename">${escapeHtml(cloudFiles[kind] ?? '')}</small></span><small>備份本機後覆蓋</small></div>`)
        .join('')
    : '<p class="tr-muted">沒有找到可還原的項目</p>';
  const missing = skipped.length > 0
    ? `<div class="tr-preview-group"><b>將略過</b>${skipped.map(kind => `<div class="tr-preview-row is-skipped"><i class="fa-solid fa-minus"></i><span>${environmentLabel(kind)}</span><small>雲端沒有備份</small></div>`).join('')}</div>`
    : '';
  return `<div class="tr-preview-group"><b>將從雲端還原</b>${ready}</div>${missing}`;
}

export function renderRestorePreviewErrorHtml(message: string): string {
  return `<div class="tr-callout tr-danger"><b>無法確認雲端備份</b><br />${escapeHtml(message)}<br /><small>為避免在資訊不完整時覆蓋本機內容，目前不會開放還原。</small></div>`;
}

export function renderRestorePointChatListHtml(chats: readonly RestorePointChatSummary[]): string {
  if (chats.length === 0) {
    return '<div class="tr-callout"><b>沒有找到雲端還原點</b><br /><small>SillyTavernSync 中目前沒有任何對話的 _pre_restore 資料夾。</small></div>';
  }
  return chats.map(chat => `
    <button type="button" class="tr-restore-chat-card" data-restore-chat data-role-key="${escapeAttribute(chat.roleKey)}" data-chat-id="${escapeAttribute(chat.chatId)}">
      <span class="tr-restore-chat-main"><small>${escapeHtml(chat.roleKey)}</small><b>${escapeHtml(chat.chatId)}</b>${chat.duplicatePath ? '<em><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 偵測到同名資料夾，已合併顯示</em>' : ''}</span>
      <span class="tr-restore-chat-meta"><b>${chat.batchCount} 個批次</b><small>${chat.latestCreatedAt ? `最新 ${escapeHtml(formatDateTime(chat.latestCreatedAt))}` : '存在空的 _pre_restore'}</small></span>
      <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
    </button>`).join('');
}

export function renderRestorePointListHtml(batches: readonly RestorePointBatch[], selectedFileIds: ReadonlySet<string> = new Set()): string {
  if (batches.length === 0) {
    return '<div class="tr-callout"><b>_pre_restore 是空的</b><br /><small>這個對話已有 _pre_restore 資料夾，但目前沒有批次。</small></div>';
  }
  return batches.map(batch => `
    <section class="tr-restore-batch" aria-labelledby="tr-restore-batch-${escapeAttribute(batch.folderId)}">
      <div class="tr-restore-batch-head">
        <div><b id="tr-restore-batch-${escapeAttribute(batch.folderId)}"><time datetime="${escapeAttribute(batch.createdAt)}">${escapeHtml(formatDateMinute(batch.createdAt))}</time></b><small>${batch.files.length} 個檔案${batch.emptyFolders.length ? ` · ${batch.emptyFolders.length} 個空資料夾` : ''}</small></div>
        ${renderRestorePointTechnicalDetails(batch)}
      </div>
      ${renderRestorePointIssues(batch)}
      <div class="tr-restore-files">
        ${batch.files.map(file => `
          <label class="tr-restore-file">
            <input type="checkbox" data-restore-file="${escapeAttribute(file.fileId)}" ${selectedFileIds.has(file.fileId) ? 'checked' : ''} aria-label="選取 ${escapeAttribute(file.relativePath)}" />
            <span class="tr-restore-file-main"><b>${escapeHtml(restorePointKindLabel(file.kind))}</b><span>${escapeHtml(restorePointFileSummary(file))}</span></span>
          </label>`).join('')}
        ${batch.emptyFolders.map(folder => `<div class="tr-restore-file is-empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><span class="tr-restore-file-main"><b>空資料夾</b><span>${escapeHtml(folder.relativePath)}</span></span></div>`).join('')}
      </div>
    </section>`).join('');
}

function renderRestorePointTechnicalDetails(batch: RestorePointBatch): string {
  const fileDetails = batch.files.map(file => `
    <div class="tr-restore-technical-group">
      <b>${escapeHtml(restorePointKindLabel(file.kind))} · ${escapeHtml(restorePointFileSummary(file))}</b>
      <div class="tr-restore-technical-row"><small>完整檔名</small><code>${escapeHtml(file.filename)}</code></div>
      <div class="tr-restore-technical-row"><small>Drive 建立時間</small><time datetime="${escapeAttribute(file.uploadedAt)}">${escapeHtml(formatDateTime(file.uploadedAt))}</time></div>
    </div>`).join('');
  const folderDetails = batch.emptyFolders.map(folder => `
    <div class="tr-restore-technical-group">
      <b>空資料夾 · ${escapeHtml(folder.relativePath)}</b>
      <div class="tr-restore-technical-row"><small>Drive 建立時間</small><time datetime="${escapeAttribute(folder.createdAt)}">${escapeHtml(formatDateTime(folder.createdAt))}</time></div>
    </div>`).join('');
  return `
    <details class="tr-restore-technical">
      <summary><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>技術資訊</span></summary>
      <div class="tr-restore-technical-content">
        <div class="tr-restore-technical-row"><small>批次 ID</small><code>${escapeHtml(batch.name)}</code></div>
        <div class="tr-restore-technical-row"><small>精確建立時間</small><time datetime="${escapeAttribute(batch.createdAt)}">${escapeHtml(formatDateTime(batch.createdAt))}</time></div>
        ${fileDetails}${folderDetails}
      </div>
    </details>`;
}

function renderRestorePointIssues(batch: RestorePointBatch): string {
  const labels = batch.issues.map(issue => ({
    empty: '這個批次沒有檔案',
    unknown_items: '包含未識別的檔案或資料夾',
    invalid_timestamp: '批次名稱不含有效時間，改用 Drive 建立時間'
  })[issue]);
  return labels.length ? `<div class="tr-restore-issues">${labels.map(label => `<span><i class="fa-solid fa-circle-info" aria-hidden="true"></i>${label}</span>`).join('')}</div>` : '';
}

function restorePointKindLabel(kind: RestorePointFileKind): string {
  return ({
    chat: '聊天', character: '角色卡', world: '世界書', persona: 'Persona', preset: 'Preset', regex: 'Regex', other: '其他'
  })[kind];
}

function restorePointFileSummary(file: RestorePointFile): string {
  const parsed = parseVersionFilename(file.filename);
  if (!parsed) return file.relativePath;
  const extension = /\.([^.]+)$/.exec(file.filename)?.[1]?.toUpperCase();
  return [parsed.device, extension].filter((part): part is string => Boolean(part)).join(' · ');
}

function formatDateMinute(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間不明' : formatLocalMinute(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間不明' : formatLocalTime(date);
}

export function renderUploadPreviewHtml(filename: string | null): string {
  if (!filename) {
    return '<div class="tr-upload-cloud-summary"><span>目前雲端檔案</span><b>尚無檔案</b></div><div class="tr-inline-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>雲端尚無此聊天，這次上傳會建立第一份聊天版本。</span></div>';
  }
  return `<div class="tr-upload-cloud-summary"><span>雲端最新版本</span><b class="tr-cloud-filename">${escapeHtml(filename)}</b></div><div class="tr-inline-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>這次會新增一份聊天版本；超過保留數量時才會清理最舊版本。</span></div>`;
}

export function renderChatUploadPreparationHtml(preparation: ChatUploadPreparationView): string {
  const chat = renderUploadPreviewHtml(preparation.latestChatFilename);
  if (preparation.recoveryStatus === 'ready') return chat;

  const choices = uploadEnvironmentChoices(preparation);
  const callout = preparation.isFirstUpload
    ? '<div class="tr-callout"><b>這是此聊天第一次上傳。</b><br />若要在其他裝置直接建立聊天，建議一起備份角色卡與相關環境。</div>'
    : '<div class="tr-callout tr-danger"><b>雲端缺少角色卡。</b><br />聊天仍可建立新版本，但其他裝置目前無法從雲端還原這張角色並建立聊天。</div>';
  return `${chat}${callout}${renderEnvironmentChoices('chat-upload', choices)}<div class="tr-callout"><small>Persona 可能包含個人資料，預設不勾選；你可以依需要加入。</small></div>`;
}

export function uploadEnvironmentChoices(preparation: ChatUploadPreparationView): EnvironmentChoiceView[] {
  const availability = new Map(preparation.environment.map(item => [item.kind, item]));
  return ENVIRONMENT_ITEM_ORDER.map(kind => {
    const item = availability.get(kind);
    const isMissing = !item?.available;
    const badge: EnvironmentChoiceView['badge'] = kind === 'character'
      ? (isMissing ? '必要' : '已有備份')
      : kind === 'world'
        ? (isMissing ? '建議' : '已有備份')
        : (item?.available ? '已有備份' : '選填');
    return {
      kind,
      selected: isMissing && (kind === 'character' || kind === 'world'),
      badge,
      latestFilename: item?.latestFilename ?? null
    };
  });
}

export function renderCloudRoleListHtml(roles: CloudRoleViewEntry[]): string {
  if (roles.length === 0) {
    return '<p class="tr-cloud-empty">雲端沒有任何備份資料夾</p>';
  }
  const items = roles
    .map(
      role => `
        <li>
          <button type="button" class="menu_button tr-cloud-role" data-cloud-role="${escapeAttribute(role.roleKey)}">
            <i class="fa-solid fa-user" aria-hidden="true"></i><span>${escapeHtml(role.roleKey)}</span><i class="fa-solid fa-chevron-right tr-cloud-role-chevron" aria-hidden="true"></i>
          </button>
        </li>`
    )
    .join('');
  return `<div class="tr-cloud-head"><b>選擇角色</b></div><ul class="tr-cloud-list">${items}</ul>`;
}

export function renderCloudChatListHtml(roleKey: string, entries: CloudChatViewEntry[]): string {
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
            ${entry.versionCount === 0 ? 'disabled' : ''}>建立</button>
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


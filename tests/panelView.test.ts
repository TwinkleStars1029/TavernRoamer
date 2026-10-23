import { describe, expect, it } from 'vitest';
import {
  buildSelfCheckReport,
  floatingHostLayout,
  formatAutoSyncLabel,
  formatPendingLabel,
  progressRatioLabel,
  renderPanel,
  renderChatUploadPreparationHtml,
  renderRestorePointChatListHtml,
  renderRestorePointListHtml,
  renderRestorePreviewErrorHtml,
  renderRestorePreviewHtml,
  renderSelfCheckResultsHtml,
  renderUploadPreviewHtml,
  statusPill,
  summarizeSelfChecks,
  summarizeProgress,
  uploadCompletionMessage
} from '../src/ui';
import type { SelfCheckResult, SyncStatus } from '../src/types';

describe('statusPill', () => {
  it.each([
    ['synced', '已是最新', 'green'],
    ['remote_available', '雲端已有版本', 'yellow'],
    ['newer_remote', '雲端有新版', 'yellow'],
    ['local_dirty', '本地有未上傳變更', 'orange'],
    ['conflict', '雙方皆有變更', 'red'],
    ['remote_missing', '雲端版本遺失', 'red'],
    ['remote_mismatch', '版本狀態異常', 'red'],
    ['check_failed', '無法核對雲端', 'grey'],
    ['untracked', '尚未同步', 'grey'],
    ['not_connected', '未連線', 'grey'],
    ['unknown', '尚未核對', 'grey']
  ] as const)('maps %s to a labelled tone', (status, label, tone) => {
    expect(statusPill(status as SyncStatus)).toEqual({ label, tone });
  });
});

describe('formatPendingLabel', () => {
  it('hides the badge when the queue is empty (or after flush)', () => {
    expect(formatPendingLabel(0)).toEqual({ text: '無', visible: false, tone: 'normal' });
  });

  it('shows a warning label when the queue is non-empty', () => {
    expect(formatPendingLabel(3)).toEqual({ text: '待傳 3 筆', visible: true, tone: 'warn' });
  });

  it('treats negative or non-finite counts as empty', () => {
    expect(formatPendingLabel(-1).visible).toBe(false);
    expect(formatPendingLabel(Number.NaN).visible).toBe(false);
  });
});

describe('formatAutoSyncLabel', () => {
  it('describes the interval when enabled', () => {
    expect(formatAutoSyncLabel({ autoSyncEnabled: true, autoSyncEveryN: 5 })).toBe('每 5 則');
  });

  it('reports disabled state', () => {
    expect(formatAutoSyncLabel({ autoSyncEnabled: false, autoSyncEveryN: 5 })).toBe('已停用');
  });
});

describe('progressRatioLabel', () => {
  it('renders settled over total', () => {
    expect(progressRatioLabel(3, 5)).toBe('3/5');
    expect(progressRatioLabel(0, 1)).toBe('0/1');
  });
});

describe('floating mobile viewport', () => {
  it('keeps vertical touch scrolling available while preventing horizontal overflow', () => {
    const styles = floatingHostLayout(320, 568);

    expect(styles).toMatchObject({
      width: '320px',
      height: '568px',
      overflowX: 'hidden',
      overflowY: 'auto',
      touchAction: 'pan-y',
      webkitOverflowScrolling: 'touch'
    });
    expect(styles).not.toHaveProperty('overflow', 'hidden');
  });
});

describe('uploadCompletionMessage', () => {
  it('appears after every chat or environment upload succeeds', () => {
    expect(uploadCompletionMessage('upload', ['done'])).toBe('全部檔案上傳完成');
    expect(uploadCompletionMessage('backup', ['done', 'done'])).toBe('全部檔案上傳完成');
  });

  it('stays hidden while uploading, after an error, and for non-upload operations', () => {
    expect(uploadCompletionMessage('backup', ['done', 'active'])).toBeNull();
    expect(uploadCompletionMessage('backup', ['done', 'error'])).toBeNull();
    expect(uploadCompletionMessage('download', ['done'])).toBeNull();
    expect(uploadCompletionMessage('upload', [])).toBeNull();
  });
});

describe('summarizeProgress', () => {
  it('keeps running work distinct from a finished operation', () => {
    expect(summarizeProgress(['done', 'active'])).toEqual({
      label: '正在處理',
      tone: 'running',
      finished: false
    });
  });

  it('reports full success only when no item failed', () => {
    expect(summarizeProgress(['done', 'done'])).toEqual({
      label: '全部完成',
      tone: 'success',
      finished: true
    });
  });

  it('reports partial and complete failure without presenting either as success', () => {
    expect(summarizeProgress(['done', 'error', 'aborted'])).toEqual({
      label: '部分完成，2 項未完成',
      tone: 'warning',
      finished: true
    });
    expect(summarizeProgress(['error'])).toEqual({
      label: '操作失敗，1 項未完成',
      tone: 'error',
      finished: true
    });
  });

  it('describes skipped-only work as neutral', () => {
    expect(summarizeProgress(['skipped'])).toEqual({
      label: '沒有可處理的項目',
      tone: 'neutral',
      finished: true
    });
  });

  it('reports queued uploads as waiting instead of failed', () => {
    expect(summarizeProgress(['done', 'queued'])).toEqual({
      label: '部分完成，1 項等待補傳',
      tone: 'warning',
      finished: true
    });
  });
});

describe('system check results', () => {
  const result = (overrides: Partial<SelfCheckResult>): SelfCheckResult => ({
    id: 'settings.valid',
    label: '同步設定',
    category: 'settings',
    safety: 'read_only',
    mode: 'quick',
    status: 'pass',
    message: '設定格式正確',
    startedAt: '2026-07-22T06:00:00.000Z',
    durationMs: 12,
    ...overrides
  });

  it('prioritizes failures over blocked prerequisites in the summary', () => {
    expect(summarizeSelfChecks([
      result({ status: 'pass' }),
      result({ id: 'drive.connection', status: 'blocked' }),
      result({ id: 'chat.raw_export', status: 'fail' })
    ])).toMatchObject({ pass: 1, blocked: 1, fail: 1, label: '需要處理 1 項', tone: 'error' });
  });

  it('renders grouped actionable results and redacts sensitive details', () => {
    const html = renderSelfCheckResultsHtml([
      result({
        status: 'blocked',
        action: 'connect_drive',
        remediation: '請先連線。',
        details: { googleClientId: 'secret-client-id', access_token: 'secret-token' }
      })
    ], { mode: 'quick', running: false, progress: null });

    expect(html).toContain('設定');
    expect(html).toContain('前往連線');
    expect(html).toContain('複製診斷報告');
    expect(html).toContain('請先連線。');
    expect(html).toContain('[已遮蔽]');
    expect(html).not.toContain('secret-client-id');
    expect(html).not.toContain('secret-token');

    const report = buildSelfCheckReport([
      result({ details: { googleClientId: 'secret-client-id', access_token: 'secret-token' } })
    ]);
    expect(report).toContain('[已遮蔽]');
    expect(report).not.toContain('secret-client-id');
    expect(report).not.toContain('secret-token');
  });
});

describe('step-based panel', () => {
  const settings = {
    deviceName: '測試電腦',
    googleClientId: 'client-id',
    autoSyncEnabled: true,
    autoSyncEveryN: 3,
    chatRetention: { mode: 'keep_latest_n' as const, latestN: 10 }
  };
  const connectedDrive = { connected: true, email: 'user@example.com', error: null };
  const contextFor = (status: SyncStatus, hasChat = true) => ({
    characterName: hasChat ? 'Sasuke' : null,
    characterId: hasChat ? '1' : null,
    chatFileName: hasChat ? 'chat.jsonl' : null,
    chatId: hasChat ? 'chat-1' : null,
    lastMessageId: hasChat ? 7 : null,
    status
  });
  const homeScreen = (html: string) => html.slice(
    html.indexOf('data-screen="home"'),
    html.indexOf('data-screen="upload-confirm"')
  );

  it('renders a task-first home and separate confirmation screens', () => {
    const html = renderPanel(
      {
        deviceName: '測試電腦',
        googleClientId: 'client-id',
        autoSyncEnabled: true,
        autoSyncEveryN: 3,
        chatRetention: { mode: 'keep_latest_n', latestN: 10 }
      },
      {
        characterName: 'Sasuke',
        characterId: '1',
        chatFileName: 'chat.jsonl',
        chatId: 'chat-1',
        lastMessageId: 7,
        status: 'synced'
      },
      { connected: true, email: 'user@example.com', error: null },
      true
    );

    expect(html).not.toContain('你想做什麼？');
    expect(html).toMatch(/data-screen="upload-confirm"[^>]*hidden/);
    expect(html).toMatch(/data-screen="restore-confirm"[^>]*hidden/);
    expect(html).toMatch(/data-screen="progress"[^>]*hidden/);
    expect(html).toContain('預覽還原內容');
    expect(html).toContain('data-drive-required');
    expect(html).toContain('階段：確認');
    expect(html).toContain('class="tr-upload-overview"');
    expect(html).not.toMatch(/步驟 \d+／\d+/);
    expect(html).toContain('data-field="progress-resume" hidden');
    expect(html).toContain('用雲端版更新');
    expect(html).toContain('從雲端建立聊天');
    expect(html).not.toContain('同步雲端最新版');
    expect(html).not.toContain('確認拉取聊天');
    expect(html).toContain('先將目前聊天保存成雲端還原點');
    expect(html).toContain('role="status" aria-live="polite" aria-busy="false"');
    expect(html).toContain('data-action="retry-restore-preview"');
    expect(html).toContain('系統檢查');
    expect(html).toContain('data-self-check-mode="quick"');
    expect(html).toContain('data-self-check-mode="advanced"');
    expect(html).not.toContain('data-action="self-check"');
    expect(html).toContain('data-external-link');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('data-field="drive-identity">user@example.com');
    expect(html).not.toContain('class="tr-hero"');
    expect(html).not.toContain('class="tr-home-meta"');
    expect(html.indexOf('data-field="progress-resume"')).toBeGreaterThan(html.indexOf('data-field="home-current"'));
    expect(html.indexOf('data-field="progress-resume"')).toBeLessThan(html.indexOf('data-field="home-current-content"'));
    expect(html).toContain('class="tr-current-status" role="status" aria-live="polite"');
    const status = html.slice(html.indexOf('class="tr-current-status"'), html.indexOf('data-field="home-current-cta"'));
    expect(status).toContain('data-field="status"');
    expect(status).toContain('data-field="home-current-meta"');
    expect(status).not.toContain('data-field="home-current-primary"');
  });

  it.each([
    ['local_dirty', 'upload-confirm', '上傳目前聊天', null],
    ['newer_remote', 'download-confirm', '用雲端版更新', '更新前會先建立還原點']
  ] as const)('shows the single primary next step for %s', (status, destination, label, note) => {
    const home = homeScreen(renderPanel(settings, contextFor(status), connectedDrive, true));

    expect(home).toContain(`data-field="home-current-primary" data-navigate="${destination}"`);
    expect(home).toContain(label);
    if (note) expect(home).toContain(note);
    expect(home.match(/\btr-primary\b/g)).toHaveLength(1);
  });

  it.each([
    ['local_dirty', 'data-navigate="upload-confirm"', '上傳目前聊天', null],
    ['newer_remote', 'data-navigate="download-confirm"', '用雲端版更新', '更新前會先建立還原點'],
    ['untracked', 'data-navigate="upload-confirm"', '上傳目前聊天', '第一次上傳會建立雲端版本'],
    ['remote_available', 'data-navigate="upload-confirm"', '上傳目前聊天', '雲端已有這段聊天的版本，上傳會新增一份；要改用雲端內容請用下方「用雲端版更新」'],
    ['remote_missing', 'data-navigate="upload-confirm"', '重新上傳', '雲端找不到上次同步的版本'],
    ['remote_mismatch', 'data-navigate="upload-confirm"', '重新上傳', '雲端最新版比上次同步的還舊，可能被清理過'],
    ['check_failed', 'data-action="refresh-status"', '重新檢查', '無法連到雲端核對'],
    ['unknown', 'data-action="refresh-status"', '重新檢查', '尚未核對雲端版本']
  ] as const)('maps %s to its guarded primary call to action', (status, destination, label, note) => {
    const home = homeScreen(renderPanel(settings, contextFor(status), connectedDrive, true));
    const primary = home.match(/<button[^>]*data-field="home-current-primary"[^>]*>.*?<\/button>/)?.[0] ?? '';
    const cta = home.slice(home.indexOf('data-field="home-current-cta"'), home.indexOf('data-field="home-actions"'));

    expect(primary).toContain(destination);
    expect(primary).toContain(`<span>${label}</span>`);
    expect(primary).toContain('data-drive-required');
    expect(primary).toContain('data-home-task');
    expect(primary).toContain('tr-primary');
    expect(primary).toMatch(/<i class="fa-solid [^"]+" aria-hidden="true">/);
    if (note) expect(cta).toContain(`<small>${note}</small>`);
    else expect(cta).not.toContain('<small>');
    expect(home.match(/\btr-primary\b/g)).toHaveLength(1);
  });

  it('asks the user to choose a side for a conflict without a primary action', () => {
    const home = homeScreen(renderPanel(settings, contextFor('conflict'), connectedDrive, true));
    const upload = home.match(/<button[^>]*data-field="home-current-conflict-upload"[^>]*>.*?<\/button>/)?.[0] ?? '';
    const download = home.match(/<button[^>]*data-field="home-current-conflict-download"[^>]*>.*?<\/button>/)?.[0] ?? '';

    expect(home).toContain('兩台裝置都改過這段聊天，請選擇要保留哪一邊。');
    expect(home).not.toContain('data-field="home-current-primary"');
    expect(home.match(/\btr-primary\b/g) ?? []).toHaveLength(0);
    expect(upload).toContain('data-navigate="upload-confirm"');
    expect(upload).toContain('上傳本機版本');
    expect(download).toContain('data-navigate="download-confirm"');
    expect(download).toContain('改用雲端版');
    for (const button of [upload, download]) {
      expect(button).toContain('data-drive-required');
      expect(button).toContain('data-home-task');
    }
  });

  it('shows the conflict warning on the download confirmation only for a conflict', () => {
    const warning = (status: SyncStatus) => renderPanel(settings, contextFor(status), connectedDrive, true)
      .match(/<div[^>]*data-field="download-conflict-warning"[^>]*>/)?.[0] ?? '';

    expect(renderPanel(settings, contextFor('conflict'), connectedDrive, true))
      .toContain('本機有尚未上傳的變更，更新後只能從雲端還原點找回。');
    expect(warning('conflict')).not.toMatch(/\shidden/);
    expect(warning('newer_remote')).toMatch(/\shidden/);
  });

  it('offers 立即補傳 next to the pending count only when uploads are pending', () => {
    const render = (pendingUploads: number) => homeScreen(renderPanel(
      settings,
      contextFor('local_dirty'),
      connectedDrive,
      true,
      false,
      { lastSyncedVersion: null, pendingUploads }
    ));
    const withPending = render(3);
    const segment = withPending.match(/<span data-field="queue-segment">.*?<\/button><\/span>/)?.[0] ?? '';
    const flushButton = withPending.match(/<button[^>]*data-action="flush-queue"[^>]*>/)?.[0] ?? '';

    expect(segment).toContain('待傳 3 筆');
    expect(segment).toContain('立即補傳');
    expect(flushButton).toContain('data-drive-required');
    expect(flushButton).toContain('data-home-task');
    expect(flushButton).not.toContain('tr-primary');
    expect(withPending.match(/\btr-primary\b/g)).toHaveLength(1);
    expect(render(0)).not.toContain('立即補傳');
    expect(render(0)).not.toContain('data-action="flush-queue"');
  });

  it('shows no primary next step for a synced chat', () => {
    const home = homeScreen(renderPanel(settings, contextFor('synced'), connectedDrive, true));

    expect(home).not.toContain('data-field="home-current-primary"');
    expect(home.match(/\btr-primary\b/g) ?? []).toHaveLength(0);
  });

  it('shows a chat hint instead of a primary action when no chat is open', () => {
    const home = homeScreen(renderPanel(settings, contextFor('unknown', false), connectedDrive, true));

    expect(home).toContain('請先在酒館開啟一段聊天');
    expect(home).not.toContain('data-field="home-current-primary"');
  });

  it('keeps sync metadata together and omits an empty pending segment', () => {
    const withPending = homeScreen(renderPanel(
      settings,
      contextFor('local_dirty'),
      connectedDrive,
      true,
      false,
      { lastSyncedVersion: null, pendingUploads: 2 }
    ));
    const withoutPending = homeScreen(renderPanel(settings, contextFor('synced'), connectedDrive, true));

    expect(withPending).toContain('最後同步');
    expect(withPending).toContain('自動同步 <b data-field="auto-sync">每 3 則');
    expect(withPending).toContain('<b data-field="queue">待傳 2 筆</b>');
    expect(withoutPending).not.toContain('data-field="queue-segment"');
  });

  it('disables every home task and the primary action while progress is running', () => {
    const home = homeScreen(renderPanel(settings, contextFor('local_dirty'), connectedDrive, true, true));
    const taskButtons = home.match(/<button[^>]*data-home-task[^>]*>/g) ?? [];

    expect(taskButtons).toHaveLength(7);
    for (const button of taskButtons) expect(button).toMatch(/\sdisabled(?:\s|>)/);
    expect(home).toContain('data-field="home-progress-lock" role="status" >目前操作完成後，才能開始新的操作。');
  });

  it('never locks the 前往連線 navigation button while progress is running', () => {
    const disconnected = { connected: false, email: null, error: null };
    const home = homeScreen(renderPanel(settings, contextFor('local_dirty'), disconnected, true, true));
    const connect = home.match(/<button[^>]*data-field="home-connect-primary"[^>]*>/)?.[0] ?? '';

    expect(connect).toContain('data-navigate="settings"');
    expect(connect).not.toMatch(/\sdisabled(?:\s|>)/);
    expect(connect).not.toContain('tr-disabled');
  });

  it('adds dialog semantics and labelled screens only in floating mode', () => {
    const settings = {
      deviceName: '測試電腦',
      googleClientId: 'client-id',
      autoSyncEnabled: true,
      autoSyncEveryN: 3,
      chatRetention: { mode: 'keep_latest_n' as const, latestN: 10 }
    };
    const context = {
      characterName: null,
      characterId: null,
      chatFileName: null,
      chatId: null,
      lastMessageId: null,
      status: 'unknown' as const
    };
    const drive = { connected: false, email: null, error: null };
    const floating = renderPanel(settings, context, drive, true);
    const embedded = renderPanel(settings, context, drive, false);

    expect(floating).toContain('role="dialog"');
    expect(floating).toContain('aria-modal="true"');
    expect(floating).toContain('aria-labelledby="tavern-roamer-dialog-title"');
    expect(floating).toContain('id="tavern-roamer-dialog-title"');
    expect(embedded).not.toContain('role="dialog"');
    expect(embedded).not.toContain('aria-modal="true"');

    for (const screen of [
      'home',
      'upload-confirm',
      'download-confirm',
      'cloud',
      'cloud-confirm',
      'environment-backup',
      'environment-restore',
      'restore-confirm',
      'restore-points',
      'progress',
      'settings'
    ]) {
      expect(floating).toContain(`aria-labelledby="tr-screen-${screen}-title"`);
      expect(floating).toContain(`id="tr-screen-${screen}-title" tabindex="-1"`);
    }
  });

  it('groups the home actions by user intent without dropping any route', () => {
    const html = renderPanel(
      {
        deviceName: '測試電腦',
        googleClientId: 'client-id',
        autoSyncEnabled: true,
        autoSyncEveryN: 3,
        chatRetention: { mode: 'keep_latest_n', latestN: 10 }
      },
      {
        characterName: null,
        characterId: null,
        chatFileName: null,
        chatId: null,
        lastMessageId: null,
        status: 'unknown'
      },
      { connected: true, email: null, error: null },
      true
    );

    expect(html).toContain('id="tr-chat-tasks-title">聊天');
    expect(html).toContain('id="tr-environment-tasks-title">酒館環境');
    expect(html).toContain('data-navigate="upload-confirm"');
    expect(html).toContain('data-navigate="download-confirm"');
    expect(html).toContain('data-action="browse-cloud"');
    expect(html).toContain('data-navigate="environment-backup"');
    expect(html).toContain('data-navigate="environment-restore"');
    expect(html).toContain('data-navigate="restore-points"');
    expect(html).toContain('data-screen="restore-points"');
    expect(html).toContain('清理超過 15 天');
    expect(html).toContain('清理超過 30 天');
  });

  it('replaces all home actions with a connection-first message while Drive is disconnected', () => {
    const settings = {
      deviceName: '測試電腦',
      googleClientId: 'client-id',
      autoSyncEnabled: true,
      autoSyncEveryN: 3,
      chatRetention: { mode: 'keep_latest_n' as const, latestN: 10 }
    };
    const context = {
      characterName: null,
      characterId: null,
      chatFileName: null,
      chatId: null,
      lastMessageId: null,
      status: 'not_connected' as const
    };
    const disconnected = renderPanel(settings, context, { connected: false, email: null, error: null }, true);
    const connected = renderPanel(settings, context, { connected: true, email: 'user@example.com', error: null }, true);

    expect(disconnected).toContain('<h3>連線 Google Drive 後就能開始同步</h3>');
    expect(disconnected).not.toMatch(/<h3[^>]*role=/);
    expect(disconnected).toContain('只需設定一次，之後每台裝置都連同一個 Drive。');
    expect(disconnected).toMatch(/data-field="home-actions" hidden/);
    expect(disconnected).not.toMatch(/data-field="home-disconnected" hidden/);
    expect(disconnected).toMatch(/data-field="home-current" hidden/);
    expect(disconnected).toContain('建立 Google Client ID');
    expect(disconnected).toContain('在設定頁填入並連線');
    expect(disconnected).toContain('前往連線');
    expect(disconnected).toContain('href="https://github.com/TwinkleStars1029/TavernRoamer/blob/main/docs/gcp-setup.md"');
    expect(homeScreen(disconnected).match(/\btr-primary\b/g)).toHaveLength(1);
    expect(connected).toMatch(/data-field="home-disconnected" hidden/);
    expect(connected).not.toMatch(/data-field="home-current" hidden/);
    expect(connected).not.toMatch(/data-field="home-actions" hidden/);
  });

  it('links the Client ID field to the focused Google setup guide', () => {
    const html = renderPanel(
      {
        deviceName: '測試電腦',
        googleClientId: '',
        autoSyncEnabled: true,
        autoSyncEveryN: 3,
        chatRetention: { mode: 'keep_latest_n', latestN: 10 }
      },
      {
        characterName: null,
        characterId: null,
        chatFileName: null,
        chatId: null,
        lastMessageId: null,
        status: 'not_connected'
      },
      { connected: false, email: null, error: null },
      true
    );

    expect(html).toContain('如何取得 Google Client ID？');
    expect(html).toContain('href="https://twinklestars1029.github.io/TavernRoamer-website/setup/google-oauth/"');
  });

  it('shows the current cloud filename and versioning behavior before upload', () => {
    const html = renderUploadPreviewHtml('2026-07-22T10-00-00Z__A<&>.jsonl');
    expect(html).toContain('雲端最新版本');
    expect(html).toContain('class="tr-upload-cloud-summary"');
    expect(html).toContain('class="tr-inline-note"');
    expect(html).toContain('2026-07-22T10-00-00Z__A&lt;&amp;&gt;.jsonl');
    expect(html).toContain('新增一份聊天版本');
    expect(html).not.toContain('覆蓋');
  });

  it('shows a first-upload message when the cloud has no file', () => {
    const html = renderUploadPreviewHtml(null);
    expect(html).toContain('尚無檔案');
    expect(html).toContain('建立第一份聊天版本');
    expect(html).not.toContain('原雲端檔案先被備份，再覆蓋');
  });

  it('offers the shared environment selector for a first upload', () => {
    const html = renderChatUploadPreparationHtml({
      preparationId: 'prep-1',
      isFirstUpload: true,
      latestChatFilename: null,
      recoveryStatus: 'first_upload',
      environment: [
        { kind: 'character', available: false, latestFilename: null },
        { kind: 'world', available: false, latestFilename: null },
        { kind: 'persona', available: false, latestFilename: null },
        { kind: 'preset', available: true, latestFilename: 'preset.json' },
        { kind: 'regex', available: false, latestFilename: null }
      ]
    });

    expect(html).toContain('這是此聊天第一次上傳');
    expect(html).toContain('data-environment-group="chat-upload"');
    expect(html).toMatch(/data-environment-kind="character"[^>]*checked/);
    expect(html).toMatch(/data-environment-kind="world"[^>]*checked/);
    expect(html).not.toMatch(/data-environment-kind="persona"[^>]*checked/);
    expect(html).toContain('雲端已有：preset.json');
    expect(html).toContain('可能包含個人資料');
  });

  it('does not show environment choices when remote recovery is ready', () => {
    const html = renderChatUploadPreparationHtml({
      preparationId: 'prep-2',
      isFirstUpload: false,
      latestChatFilename: 'chat.jsonl',
      recoveryStatus: 'ready',
      environment: [{ kind: 'character', available: true, latestFilename: 'character.json' }]
    });

    expect(html).not.toContain('data-environment-group="chat-upload"');
    expect(html).toContain('新增一份聊天版本');
  });

  it('shows each latest cloud filename in the restore confirmation', () => {
    const html = renderRestorePreviewHtml(
      {
        character: '2026-07-22T12-00-00Z__A<&>.json',
        world: null
      },
      ['character', 'world']
    );
    expect(html).toContain('角色卡');
    expect(html).toContain('2026-07-22T12-00-00Z__A&lt;&amp;&gt;.json');
    expect(html).toContain('世界書');
    expect(html).toContain('雲端沒有備份');
  });

  it('blocks restore with a retryable explanation when preview cannot be verified', () => {
    const html = renderRestorePreviewErrorHtml('Drive 暫時無法連線 <retry>');
    expect(html).toContain('無法確認雲端備份');
    expect(html).toContain('目前不會開放還原');
    expect(html).toContain('Drive 暫時無法連線 &lt;retry&gt;');
  });
});

describe('restore point management view', () => {
  it('renders a global conversation index independent of the active chat', () => {
    const html = renderRestorePointChatListHtml([{
      key: '["RoleA","ChatA"]',
      roleKey: 'RoleA',
      chatId: 'ChatA',
      batchCount: 2,
      latestCreatedAt: '2026-10-01T01:01:00.000Z',
      restoreRootCount: 1,
      duplicatePath: false
    }]);

    expect(html).toContain('data-role-key="RoleA"');
    expect(html).toContain('data-chat-id="ChatA"');
    expect(html).toContain('2 個批次');
    expect(html).toContain('最新');
  });

  it('keeps restore-point timestamps concise and progressively reveals technical details', () => {
    const html = renderRestorePointListHtml([{
      roleKey: 'RoleA',
      chatId: 'ChatA',
      folderId: 'batch-1',
      name: '2026-10-01T01-01-00Z',
      createdAt: '2026-10-01T01:01:00.000Z',
      emptyFolders: [],
      issues: [],
      files: [{
        roleKey: 'RoleA',
        chatId: 'ChatA',
        fileId: 'file-1',
        filename: '2026-10-01T01-01-02Z__A.jsonl',
        kind: 'chat',
        relativePath: '2026-10-01T01-01-02Z__A.jsonl',
        batchFolderId: 'batch-1',
        batchName: '2026-10-01T01-01-00Z',
        uploadedAt: '2026-10-01T01:01:02.000Z',
        updatedAt: '2026-10-01T01:01:02.000Z'
      }]
    }]);

    expect(html).not.toContain('還原點建立');
    expect(html).not.toContain('放入 _pre_restore');
    expect(html).toContain('<span>技術資訊</span>');
    expect(html).toContain('批次 ID');
    expect(html).toContain('Drive 建立時間');
    expect(html).toContain('A · JSONL');
    expect(html).toContain('data-restore-file="file-1"');
    expect(html).toContain('2026-10-01T01-01-02Z__A.jsonl');
  });

  it('renders an explicit empty state', () => {
    expect(renderRestorePointListHtml([])).toContain('_pre_restore 是空的');
  });
});

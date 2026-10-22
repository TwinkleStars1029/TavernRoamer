import type { SelfCheckCategory, SelfCheckMode, SelfCheckResult } from '../types';
import { escapeHtml } from './html';
import type { SelfCheckProgressView } from './types';

export type SelfCheckSummary = {
  pass: number;
  fail: number;
  blocked: number;
  notApplicable: number;
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
};

export function summarizeSelfChecks(results: readonly SelfCheckResult[]): SelfCheckSummary {
  const pass = results.filter(result => result.status === 'pass').length;
  const fail = results.filter(result => result.status === 'fail').length;
  const blocked = results.filter(result => result.status === 'blocked').length;
  const notApplicable = results.filter(result => result.status === 'not_applicable').length;
  if (fail > 0) {
    return { pass, fail, blocked, notApplicable, label: `需要處理 ${fail} 項`, tone: 'error' };
  }
  if (blocked > 0) {
    return { pass, fail, blocked, notApplicable, label: `缺少前置條件 ${blocked} 項`, tone: 'warning' };
  }
  if (results.length > 0) {
    return { pass, fail, blocked, notApplicable, label: '全部正常', tone: 'success' };
  }
  return { pass, fail, blocked, notApplicable, label: '尚未執行', tone: 'neutral' };
}

export function renderSelfCheckResultsHtml(
  results: readonly SelfCheckResult[],
  state: { mode: SelfCheckMode; running: boolean; progress: SelfCheckProgressView | null }
): string {
  const summary = summarizeSelfChecks(results);
  const progress = state.progress;
  const running = state.running
    ? `<div class="tr-check-running"><i class="fa-solid fa-spinner fa-spin"></i><span><b>${escapeHtml(progress?.currentLabel ?? '準備檢查…')}</b><small>${progress ? `${progress.completed}/${progress.total}` : '0/—'}</small></span></div>`
    : '';
  if (results.length === 0 && !state.running) {
    return `<p class="tr-check-empty">${state.mode === 'advanced' ? '尚未執行進階診斷。請只在專用測試資料上使用。' : '尚未執行快速檢查。'}</p>`;
  }
  const categories = SELF_CHECK_CATEGORY_ORDER
    .map(category => {
      const categoryResults = results.filter(result => result.category === category);
      if (categoryResults.length === 0) return '';
      return `<section class="tr-check-group"><h3>${SELF_CHECK_CATEGORY_LABELS[category]}</h3><ul>${categoryResults.map(renderSelfCheckResultRow).join('')}</ul></section>`;
    })
    .join('');
  const copyAction = !state.running && results.length > 0
    ? '<button type="button" class="menu_button tr-check-copy-report" data-self-check-action="copy_report"><i class="fa-solid fa-copy"></i><span>複製診斷報告</span></button>'
    : '';
  return `
    ${running}
    <div class="tr-check-summary tr-check-summary-${summary.tone}">
      <span class="tr-check-summary-copy"><b>${escapeHtml(state.running ? '檢查進行中' : summary.label)}</b><small>通過 ${summary.pass}｜需處理 ${summary.fail}｜待完成 ${summary.blocked}｜不適用 ${summary.notApplicable}</small></span>
      ${copyAction}
    </div>
    <div class="tr-check-groups">${categories}</div>
  `;
}

export function buildSelfCheckReport(results: readonly SelfCheckResult[]): string {
  const summary = summarizeSelfChecks(results);
  const environment = {
    generatedAt: new Date().toISOString(),
    origin: globalThis.location?.origin ?? 'unknown',
    userAgent: globalThis.navigator?.userAgent ?? 'unknown'
  };
  const rows = results.map(result => ({
    label: result.label,
    message: result.message,
    remediation: result.remediation,
    technical: JSON.parse(safeSelfCheckDetails(result)) as unknown
  }));
  return JSON.stringify({ summary, environment, results: rows }, null, 2);
}

const SELF_CHECK_CATEGORY_ORDER: SelfCheckCategory[] = [
  'settings',
  'drive',
  'chat',
  'environment_backup',
  'environment_restore',
  'cloud_chat',
  'autosync',
  'advanced'
];

const SELF_CHECK_CATEGORY_LABELS: Record<SelfCheckCategory, string> = {
  settings: '設定',
  drive: 'Google Drive',
  chat: '目前聊天',
  environment_backup: '環境備份',
  environment_restore: '環境還原',
  cloud_chat: '從雲端建立聊天',
  autosync: '自動同步',
  advanced: '進階診斷'
};

function renderSelfCheckResultRow(result: SelfCheckResult): string {
  const action = result.action === 'connect_drive' || result.action === 'open_settings'
    ? `<button type="button" class="menu_button tr-check-action" data-self-check-action="${result.action}">${result.action === 'connect_drive' ? '前往連線' : '開啟設定'}</button>`
    : '';
  const remediation = result.remediation
    ? `<small class="tr-check-remediation">${escapeHtml(result.remediation)}</small>`
    : '';
  const technical = safeSelfCheckDetails(result);
  return `
    <li class="tr-check-row tr-check-${result.status}">
      <span class="tr-check-icon">${selfCheckStatusIcon(result.status)}</span>
      <span class="tr-check-copy"><b>${escapeHtml(result.label)}</b><small>${escapeHtml(result.message)}</small>${remediation}</span>
      ${action}
      <details class="tr-check-details"><summary>技術資訊</summary><pre>${escapeHtml(technical)}</pre></details>
    </li>
  `;
}

function selfCheckStatusIcon(status: SelfCheckResult['status']): string {
  if (status === 'pass') return '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>';
  if (status === 'fail') return '<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>';
  if (status === 'blocked') return '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
  return '<i class="fa-solid fa-circle-minus" aria-hidden="true"></i>';
}

function safeSelfCheckDetails(result: SelfCheckResult): string {
  const payload = redactSensitive({
    id: result.id,
    status: result.status,
    category: result.category,
    safety: result.safety,
    mode: result.mode,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    details: result.details
  });
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return JSON.stringify({ id: result.id, status: result.status, details: '[無法序列化]' }, null, 2);
  }
}

function redactSensitive(value: unknown, key = ''): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey.includes('access_token') ||
    normalizedKey === 'token' ||
    normalizedKey === 'googleclientid' ||
    normalizedKey === 'clientid'
  ) {
    return '[已遮蔽]';
  }
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactSensitive(childValue, childKey)
      ])
    );
  }
  return value;
}

// ── 版面 ───────────────────────────────────────────────────────────


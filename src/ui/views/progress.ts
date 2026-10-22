import { escapeAttribute, escapeHtml } from '../html';
import type { ProgressRow, ProgressRowState } from '../progressModel';

export function renderProgressRow(row: ProgressRow): string {
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

function progressIcon(state: ProgressRowState): string {
  switch (state) {
    case 'active':
      return '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    case 'done':
      return '<span class="tr-ok" aria-label="完成">✓</span>';
    case 'queued':
      return '<i class="fa-solid fa-clock tr-queued" aria-label="等待補傳"></i>';
    case 'warning':
      return '<i class="fa-solid fa-triangle-exclamation tr-abort" aria-label="部分完成"></i>';
    case 'error':
      return '<span class="tr-err" aria-label="失敗">✗</span>';
    case 'aborted':
      return '<span class="tr-abort" aria-label="已中止">⚠</span>';
    case 'skipped':
    case 'pending':
    default:
      return '<span class="tr-dot" aria-hidden="true">·</span>';
  }
}

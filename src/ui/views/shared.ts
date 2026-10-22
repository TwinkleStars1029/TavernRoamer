import type { TavernContext } from '../../types';
import type { PillTone } from '../formatters';
import { escapeHtml } from '../html';

export type PanelScreen =
  | 'home'
  | 'upload-confirm'
  | 'download-confirm'
  | 'cloud'
  | 'cloud-confirm'
  | 'environment-backup'
  | 'environment-restore'
  | 'restore-confirm'
  | 'restore-points'
  | 'progress'
  | 'settings'
  | 'appearance';

export function iconButton(action: string, icon: string, label: string, driveRequired = false, hidden = false): string {
  return `<button type="button" class="menu_button menu_button_icon ${driveRequired || action === 'save-appearance' || action === 'save' ? 'tr-primary' : ''}" data-action="${action}" ${driveRequired ? 'data-drive-required' : ''} ${hidden ? 'hidden' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
}

export function stepHeading(
  screen: PanelScreen,
  stage: '選擇' | '確認' | '執行' | '設定' | '管理',
  title: string,
  description: string
): string {
  return `<div class="tr-step-heading"><div class="tr-step-meta"><span>階段：${stage}</span></div><h2 id="tr-screen-${screen}-title" tabindex="-1">${title}</h2><p>${description}</p></div>`;
}

export function stepFooter(back: PanelScreen, primary: string): string {
  return `<div class="tr-step-footer"><button type="button" class="menu_button" data-navigate="${back}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>上一步</span></button><div>${primary}</div></div>`;
}

export function chatSummary(context: TavernContext, pill: { label: string; tone: PillTone }): string {
  return `<div class="tr-summary-card"><div><span>角色</span><b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b></div><div><span>聊天檔</span><b data-field="chat-file">${escapeHtml(context.chatFileName ?? '未知')}</b></div><div><span>聊天 ID</span><b data-field="chat-id">${escapeHtml(context.chatId ?? '尚未同步')}</b></div><div><span>同步狀態</span><b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b></div></div>`;
}

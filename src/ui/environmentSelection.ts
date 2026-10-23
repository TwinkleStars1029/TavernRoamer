import type { EnvironmentItemKind } from '../environment/types';
import { escapeAttribute, escapeHtml } from './html';
import { ENVIRONMENT_ITEM_ORDER, ENVIRONMENT_PRESENTATION } from './environmentPresentation';

export type EnvironmentChoiceView = {
  kind: EnvironmentItemKind;
  selected: boolean;
  disabled?: boolean;
  badge?: '必要' | '建議' | '已有備份' | '選填';
  latestFilename?: string | null;
};

export function defaultEnvironmentChoices(selected = true): EnvironmentChoiceView[] {
  return ENVIRONMENT_ITEM_ORDER.map(kind => ({ kind, selected }));
}

export function renderEnvironmentChoices(group: string, choices: readonly EnvironmentChoiceView[]): string {
  return `<div class="tr-choice-list" data-environment-group="${escapeAttribute(group)}">${choices.map(choice => {
    const presentation = ENVIRONMENT_PRESENTATION[choice.kind];
    const badge = choice.badge ? `<em class="tr-choice-badge">${escapeHtml(choice.badge)}</em>` : '';
    const latest = choice.latestFilename
      ? `<small class="tr-choice-version">雲端已有：${escapeHtml(choice.latestFilename)}</small>`
      : '';
    return `<label class="tr-choice-row${choice.badge === '必要' ? ' is-required' : ''}${choice.latestFilename ? ' is-available' : ''}"><input data-environment-kind="${choice.kind}" data-environment-group="${escapeAttribute(group)}" type="checkbox" ${choice.selected ? 'checked' : ''} ${choice.disabled ? 'disabled' : ''} /><span><span class="tr-choice-title"><b>${escapeHtml(presentation.label)}</b>${badge}</span><small>${escapeHtml(presentation.description)}</small>${latest}</span><i class="fa-solid fa-check" aria-hidden="true"></i></label>`;
  }).join('')}</div>`;
}

export function collectEnvironmentSelection(container: ParentNode | null | undefined, group: string): EnvironmentItemKind[] {
  if (!container) return [];
  const selected = new Set(
    [...container.querySelectorAll<HTMLInputElement>(`[data-environment-group="${cssAttributeValue(group)}"][data-environment-kind]`)]
      .filter(input => input.checked && !input.disabled)
      .map(input => input.dataset.environmentKind)
  );
  return ENVIRONMENT_ITEM_ORDER.filter(kind => selected.has(kind));
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

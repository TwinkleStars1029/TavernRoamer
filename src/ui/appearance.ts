import { normalizeAppearance } from '../appearance';
export { defaultAppearance, normalizeAppearance } from '../appearance';

export const accentPresets = [
  { name: '霧藍', color: '#8aa8ff' },
  { name: '薰衣草', color: '#b39ddb' },
  { name: '薄荷', color: '#66bfa3' },
  { name: '玫瑰', color: '#dc91ab' },
  { name: '琥珀', color: '#d6a64c' }
] as const;

/** Theme overrides stay on the panel; removing them resumes host theme inheritance. */
export function applyAppearance(root: HTMLElement, value: unknown): void {
  const appearance = normalizeAppearance(value);
  root.dataset.appearanceMode = appearance.mode;
  root.dataset.appearanceTone = appearance.tone;
  if (appearance.accentColor) {
    root.style.setProperty('--tr-accent-source', appearance.accentColor);
  } else {
    root.style.removeProperty('--tr-accent-source');
  }
}

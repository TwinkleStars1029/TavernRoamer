import type { AppearanceSettings } from './types';

export const defaultAppearance: AppearanceSettings = {
  mode: 'tavern',
  accentColor: null,
  tone: 'standard'
};

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const candidate = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    mode: candidate.mode === 'light' || candidate.mode === 'dark' ? candidate.mode : 'tavern',
    accentColor: typeof candidate.accentColor === 'string' && /^#[\da-f]{6}$/i.test(candidate.accentColor)
      ? candidate.accentColor.toLowerCase()
      : null,
    tone: candidate.tone === 'soft' || candidate.tone === 'vivid' ? candidate.tone : 'standard'
  };
}

import { describe, expect, it } from 'vitest';
import { normalizeAppearance } from '../src/appearance';
import { applyAppearance } from '../src/ui/appearance';

describe('appearance', () => {
  it('falls back for unknown modes, tones and CSS payloads from persisted settings', () => {
    expect(normalizeAppearance({ mode: 'unknown', tone: 'unknown', accentColor: '#fff; color: red' }))
      .toEqual({ mode: 'tavern', tone: 'standard', accentColor: null });
    expect(normalizeAppearance(null)).toEqual(normalizeAppearance(undefined));
  });

  it('removes the custom accent when reverting to the host theme', () => {
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key)
      }
    } as unknown as HTMLElement;
    applyAppearance(root, { mode: 'dark', tone: 'vivid', accentColor: '#dc91ab' });
    expect(properties.get('--tr-accent-source')).toBe('#dc91ab');
    expect(root.dataset.appearanceMode).toBe('dark');
    applyAppearance(root, undefined);
    expect(properties.size).toBe(0);
    expect(root.dataset).toEqual({ appearanceMode: 'tavern', appearanceTone: 'standard' });
  });
});

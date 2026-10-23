import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, saveSettings } from '../src/settings';
import { SETTINGS_KEY } from '../src/types';

describe('settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists settings through Tavern Helper script variables', () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('getScriptId', () => 'test-script');
    vi.stubGlobal('getVariables', () => store);
    vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => {
      Object.assign(store, value);
      return store;
    });

    saveSettings({
      deviceName: 'B電腦',
      googleClientId: 'client-id',
      autoSyncEnabled: true,
      autoSyncEveryN: 5,
      chatRetention: {
        mode: 'keep_latest_n',
        latestN: 7
      }
    });

    expect(store[SETTINGS_KEY]).toMatchObject({ deviceName: 'B電腦', autoSyncEveryN: 5 });
    expect(loadSettings()).toMatchObject({ deviceName: 'B電腦', googleClientId: 'client-id' });
  });

  it('normalizes invalid persisted values', () => {
    const store = {
      [SETTINGS_KEY]: {
        deviceName: '',
        googleClientId: 123,
        autoSyncEveryN: -1,
        chatRetention: {
          mode: 'unknown',
          latestN: 0
        }
      }
    };
    vi.stubGlobal('getVariables', () => store);

    const settings = loadSettings();

    expect(settings.deviceName).toBeTruthy();
    expect(settings.googleClientId).toBe('');
    expect(settings.autoSyncEveryN).toBe(1);
    expect(settings.chatRetention).toEqual({ mode: 'keep_latest_n', latestN: 10 });
    expect(settings.appearance).toEqual({ mode: 'tavern', accentColor: null, tone: 'standard' });
  });

  it('persists appearance with existing connection and sync preferences', () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('getVariables', () => store);
    vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(store, value));
    const saved = saveSettings({
      ...loadSettings(),
      deviceName: '手機',
      googleClientId: 'client-id',
      appearance: { mode: 'light', accentColor: '#B39DDB', tone: 'soft' }
    });
    expect(loadSettings()).toEqual(saved);
    expect(saved.appearance).toEqual({ mode: 'light', accentColor: '#b39ddb', tone: 'soft' });
    expect(saved.googleClientId).toBe('client-id');
  });
});

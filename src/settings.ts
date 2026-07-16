import { SCRIPT_ID, SETTINGS_KEY, type Settings } from './types';

export const defaultSettings: Settings = {
  deviceName: defaultDeviceName(),
  googleClientId: '',
  autoSyncEnabled: true,
  autoSyncEveryN: 1,
  chatRetention: {
    mode: 'keep_latest_n',
    latestN: 10
  }
};

export function normalizeSettings(value: unknown): Settings {
  const candidate = isRecord(value) ? value : {};
  const chatRetention = isRecord(candidate.chatRetention) ? candidate.chatRetention : {};

  return {
    deviceName: readString(candidate.deviceName, defaultSettings.deviceName),
    googleClientId: readString(candidate.googleClientId, ''),
    autoSyncEnabled: typeof candidate.autoSyncEnabled === 'boolean' ? candidate.autoSyncEnabled : true,
    autoSyncEveryN: readPositiveInteger(candidate.autoSyncEveryN, defaultSettings.autoSyncEveryN),
    chatRetention: {
      mode: chatRetention.mode === 'keep_all' ? 'keep_all' : 'keep_latest_n',
      latestN: readPositiveInteger(chatRetention.latestN, defaultSettings.chatRetention.latestN)
    }
  };
}

export function loadSettings(): Settings {
  return normalizeSettings(readScriptVariable(SETTINGS_KEY));
}

export function saveSettings(settings: Settings): Settings {
  const normalized = normalizeSettings(settings);
  writeScriptVariable(SETTINGS_KEY, normalized);
  return normalized;
}

export function readScriptVariable(key: string): unknown {
  const globals = globalThis as Record<string, any>;
  if (typeof globals.getVariables === 'function') {
    const variables = globals.getVariables({
      type: 'script',
      script_id: typeof globals.getScriptId === 'function' ? globals.getScriptId() : SCRIPT_ID
    });
    return variables?.[key];
  }

  try {
    const raw = globalThis.localStorage?.getItem(`${SCRIPT_ID}:${key}`);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function writeScriptVariable(key: string, value: unknown): void {
  const globals = globalThis as Record<string, any>;
  if (typeof globals.insertOrAssignVariables === 'function') {
    globals.insertOrAssignVariables(
      { [key]: value },
      {
        type: 'script',
        script_id: typeof globals.getScriptId === 'function' ? globals.getScriptId() : SCRIPT_ID
      }
    );
    return;
  }

  globalThis.localStorage?.setItem(`${SCRIPT_ID}:${key}`, JSON.stringify(value));
}

function defaultDeviceName(): string {
  const host = globalThis.location?.hostname;
  if (host) {
    return host === '127.0.0.1' || host === 'localhost' ? 'A電腦' : host;
  }
  return 'A電腦';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

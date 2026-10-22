export type TavernGlobals = Record<string, any>;

export function getTavernGlobals(): TavernGlobals {
  return globalThis as TavernGlobals;
}

export function getSillyTavernContext(): TavernGlobals | null {
  const candidates = [getTavernGlobals(), safeParentWindow()].filter(Boolean) as TavernGlobals[];
  for (const candidate of candidates) {
    const provider = candidate.SillyTavern;
    const context = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
    if (context && typeof context === 'object') {
      return context;
    }
  }
  return null;
}

function safeParentWindow(): TavernGlobals | null {
  try {
    const currentWindow = globalThis as unknown as Window;
    return currentWindow.parent && currentWindow.parent !== currentWindow
      ? currentWindow.parent as unknown as TavernGlobals
      : null;
  } catch {
    return null;
  }
}

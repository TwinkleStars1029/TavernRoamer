import type {
  CharacterRoundtripProbe,
  TavernDiagnosticsPort,
  TavernEventDiagnostics
} from '../app/TavernDiagnosticsPort';
import type { EnvironmentItemKind } from '../environment/types';
import { getSillyTavernContext, getTavernGlobals } from './host';

export function createTavernDiagnostics(): TavernDiagnosticsPort {
  return {
    environmentRestoreMissing,
    characterRoundtrip,
    chatReadMissing,
    eventDiagnostics,
    chatReplaceMissing,
    setChatMessages,
    pullMissing,
    hasContext: () => getSillyTavernContext() !== null
  };
}

function environmentRestoreMissing(kind: EnvironmentItemKind): string[] {
  const globals = getTavernGlobals();
  const context = getSillyTavernContext();
  const missing: string[] = [];
  if (kind === 'character' && typeof globals.createOrReplaceCharacter !== 'function') missing.push('createOrReplaceCharacter');
  if (kind === 'world') {
    if (typeof context?.loadWorldInfo === 'function') {
      if (typeof context.saveWorldInfo !== 'function') missing.push('saveWorldInfo');
    } else if (typeof globals.createOrReplaceWorldbook !== 'function' && typeof globals.replaceWorldbook !== 'function') {
      missing.push('saveWorldInfo/createOrReplaceWorldbook/replaceWorldbook');
    }
  }
  if (kind === 'persona' && typeof globals.createOrReplacePersona !== 'function' && typeof context?.createOrReplacePersona !== 'function') {
    missing.push('createOrReplacePersona');
  }
  if (kind === 'preset') {
    const manager = context?.getPresetManager?.('openai');
    if (typeof manager?.savePreset !== 'function') missing.push('openai.savePreset');
    if (typeof manager?.selectPreset !== 'function') missing.push('openai.selectPreset');
  }
  if (kind === 'regex' && typeof globals.replaceTavernRegexes !== 'function') missing.push('replaceTavernRegexes');
  return missing;
}

async function characterRoundtrip(): Promise<CharacterRoundtripProbe> {
  const globals = getTavernGlobals();
  const supported = typeof globals.getCharacter === 'function' &&
    typeof globals.createOrReplaceCharacter === 'function' && typeof globals.deleteCharacter === 'function';
  const currentName = globals.getCurrentCharacterName?.();
  if (!supported || !currentName) {
    return { supported, selected: Boolean(currentName), tempName: null, copiedExtensions: false, cleanupError: null };
  }
  const original = await globals.getCharacter('current');
  const tempName = `TavernRoamer SelfCheck ${Date.now()}`;
  let copiedExtensions = false;
  let cleanupError: string | null = null;
  try {
    await globals.createOrReplaceCharacter(tempName, original, { render: 'none' });
    copiedExtensions = Boolean((await globals.getCharacter(tempName))?.extensions);
  } finally {
    try {
      await globals.deleteCharacter(tempName, { delete_chats: false });
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      console.error('[TavernRoamer self-check] character cleanup failed', { tempName, cleanupError });
    }
  }
  return { supported, selected: true, tempName, copiedExtensions, cleanupError };
}

function chatReadMissing(): string[] {
  const globals = getTavernGlobals();
  return ['getChatMessages', 'getVariables'].filter(name => typeof globals[name] !== 'function');
}

function eventDiagnostics(): TavernEventDiagnostics {
  const globals = getTavernGlobals();
  return {
    missing: typeof globals.eventOn === 'function' ? [] : ['eventOn'],
    chatChanged: globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed（fallback）',
    generationEnded: globals.tavern_events?.GENERATION_ENDED ?? globals.tavern_events?.MESSAGE_RECEIVED ?? 'generation_ended（fallback）'
  };
}

function chatReplaceMissing(): string[] {
  return typeof getTavernGlobals().setChatMessages === 'function' ? [] : ['setChatMessages'];
}

async function setChatMessages(messages: Array<Record<string, unknown>>): Promise<void> {
  const api = getTavernGlobals().setChatMessages;
  if (typeof api !== 'function') throw new Error('setChatMessages API is unavailable');
  await api(messages, { refresh: 'none' });
}

function pullMissing(): string[] {
  const globals = getTavernGlobals();
  const context = getSillyTavernContext();
  const missing = ['openCharacterChat', 'selectCharacterById'].filter(name => typeof context?.[name] !== 'function');
  if (!Array.isArray(context?.characters)) missing.push('characters');
  if (typeof globals.insertOrAssignVariables !== 'function') missing.push('insertOrAssignVariables');
  if (typeof globals.createOrReplaceCharacter !== 'function') missing.push('createOrReplaceCharacter');
  return missing;
}

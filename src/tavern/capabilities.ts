import { getSillyTavernContext, getTavernGlobals } from './host';

export type TavernCapabilities = {
  helper: boolean;
  rawChat: boolean;
  chatPull: boolean;
  environment: {
    character: boolean;
    world: boolean;
    persona: boolean;
    preset: boolean;
    regex: boolean;
  };
};

export function detectTavernCapabilities(): TavernCapabilities {
  const globals = getTavernGlobals();
  const context = getSillyTavernContext();
  return {
    helper: typeof globals.getVariables === 'function',
    rawChat: typeof fetch === 'function' && Boolean(context?.getCurrentChatId || context?.chatId),
    chatPull: typeof context?.openCharacterChat === 'function' && Array.isArray(context?.characters),
    environment: {
      character: typeof globals.getCharacter === 'function' && typeof globals.createOrReplaceCharacter === 'function',
      world: (typeof context?.loadWorldInfo === 'function' && typeof context?.saveWorldInfo === 'function') ||
        (typeof globals.getWorldbook === 'function' &&
          (typeof globals.createOrReplaceWorldbook === 'function' || typeof globals.replaceWorldbook === 'function')),
      persona: typeof globals.getPersona === 'function' &&
        typeof (globals.createOrReplacePersona ?? context?.createOrReplacePersona) === 'function',
      preset: typeof context?.getPresetManager === 'function',
      regex: typeof globals.getTavernRegexes === 'function' && typeof globals.replaceTavernRegexes === 'function'
    }
  };
}

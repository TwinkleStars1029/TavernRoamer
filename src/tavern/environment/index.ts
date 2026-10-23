import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import { createChatMetaAdapter } from '../chatMeta';
import { createCharacterAdapter } from './character';
import { createPersonaAdapter } from './persona';
import { createPresetAdapter } from './preset';
import { createRegexAdapter } from './regex';
import { createWorldAdapter } from './world';
import { createEnvironmentContextAdapter } from './context';

export function createEnvironmentAdapter(): EnvironmentPort {
  return {
    ...createChatMetaAdapter(),
    ...createEnvironmentContextAdapter(),
    ...createCharacterAdapter(),
    ...createWorldAdapter(),
    ...createPersonaAdapter(),
    ...createPresetAdapter(),
    ...createRegexAdapter()
  };
}

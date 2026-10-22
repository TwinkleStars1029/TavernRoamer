import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import { getSillyTavernContext, getTavernGlobals } from '../host';
import { isPlainRecord } from '../helpers';
import { parseEnvironmentSnapshot } from '../../environment/validation';
import { assertEnvironmentContext } from './context';

type PresetPort = Pick<EnvironmentPort, 'exportPreset' | 'applyPreset'>;

export function createPresetAdapter(): PresetPort {
  const globals = getTavernGlobals();
  return {
    async exportPreset() {
      const manager = getSillyTavernContext()?.getPresetManager?.('openai');
      const name = typeof manager?.getSelectedPresetName === 'function' ? manager.getSelectedPresetName() : null;
      const data = name && typeof manager?.getCompletionPresetByName === 'function'
        ? manager.getCompletionPresetByName(name)
        : null;
      if (!name || !isPlainRecord(data)) throw new Error('Preset export API is unavailable');
      return {
        kind: 'preset', exportedAt: new Date().toISOString(), name,
        format: 'sillytavern-openai-preset-v1', data: structuredClone(data)
      };
    },
    async applyPreset(snapshot, contextKey) {
      snapshot = parseEnvironmentSnapshot('preset', snapshot);
      assertEnvironmentContext(contextKey);
      if (snapshot.format === 'sillytavern-openai-preset-v1') {
        const manager = getSillyTavernContext()?.getPresetManager?.('openai');
        if (!snapshot.name || !isPlainRecord(snapshot.data) || typeof manager?.savePreset !== 'function') {
          throw new Error('Raw OpenAI Preset restore API is unavailable');
        }
        await manager.savePreset(snapshot.name, structuredClone(snapshot.data), { skipUpdate: false });
        assertEnvironmentContext(contextKey);
        const selectedValue = findPresetOptionValue(manager, snapshot.name);
        if (selectedValue !== null && typeof manager.selectPreset === 'function') manager.selectPreset(selectedValue);
        return;
      }
      if (snapshot.format === 'tavern-helper-preset-v1') {
        if (!snapshot.name || typeof globals.createOrReplacePreset !== 'function' || typeof globals.loadPreset !== 'function') {
          throw new Error('Complete Preset restore API is unavailable');
        }
        if (!isCompleteTavernHelperPreset(snapshot.data)) throw new Error('Complete Preset backup is invalid');
        await globals.createOrReplacePreset(snapshot.name, structuredClone(snapshot.data), { render: 'immediate' });
        assertEnvironmentContext(contextKey);
        if (globals.loadPreset(snapshot.name) === false) {
          throw new Error(`Preset was restored but could not be loaded: ${snapshot.name}`);
        }
        return;
      }
      if (snapshot.format !== 'sillytavern-textgenerationwebui-preset-v1') {
        throw new Error(`Unsupported Preset backup format: ${String(snapshot.format)}`);
      }
      const manager = getSillyTavernContext()?.getPresetManager?.('textgenerationwebui');
      if (!snapshot.name || typeof manager?.savePreset !== 'function') throw new Error('Preset restore API is unavailable');
      await manager.savePreset(snapshot.name, snapshot.data, { skipUpdate: false });
      assertEnvironmentContext(contextKey);
      const selectedValue = findPresetOptionValue(manager, snapshot.name);
      if (selectedValue !== null && typeof manager.selectPreset === 'function') manager.selectPreset(selectedValue);
    }
  };
}

function findPresetOptionValue(
  manager: { getSelectedPreset?: () => unknown; findPreset?: (name: string) => unknown },
  name: string
): string | null {
  if (typeof manager.findPreset === 'function') {
    const found = manager.findPreset(name);
    return typeof found === 'string' ? found : null;
  }
  const selected = manager.getSelectedPreset?.();
  return typeof selected === 'string' ? selected : null;
}

function isCompleteTavernHelperPreset(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isPlainRecord(value.settings) && Array.isArray(value.prompts) &&
    Array.isArray(value.prompts_unused) && isPlainRecord(value.extensions);
}

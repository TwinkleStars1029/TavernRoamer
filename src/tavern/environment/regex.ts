import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import { getTavernGlobals } from '../host';
import { parseEnvironmentSnapshot } from '../../environment/validation';
import { assertEnvironmentContext } from './context';

type RegexPort = Pick<EnvironmentPort, 'exportRegex' | 'applyRegex'>;

export function createRegexAdapter(): RegexPort {
  const globals = getTavernGlobals();
  return {
    async exportRegex() {
      if (typeof globals.getTavernRegexes !== 'function') throw new Error('Regex export API is unavailable');
      const items = await globals.getTavernRegexes({ type: 'global' });
      return { kind: 'regex', exportedAt: new Date().toISOString(), scope: 'global', items: Array.isArray(items) ? items : [] };
    },
    async applyRegex(snapshot, contextKey) {
      snapshot = parseEnvironmentSnapshot('regex', snapshot);
      assertEnvironmentContext(contextKey);
      if (typeof globals.replaceTavernRegexes !== 'function') throw new Error('Regex restore API is unavailable');
      if (typeof globals.getTavernRegexes !== 'function') throw new Error('Regex merge API is unavailable');
      const current = await globals.getTavernRegexes({ type: 'global' });
      assertEnvironmentContext(contextKey);
      if (!Array.isArray(current)) throw new Error('目前全域 Regex 格式無法讀取');
      const merged = mergeRegexItems(current, snapshot.items);
      await globals.replaceTavernRegexes(merged, { type: snapshot.scope });
      assertEnvironmentContext(contextKey);
    }
  };
}

function mergeRegexItems(current: unknown[], incoming: unknown[]): unknown[] {
  const incomingByKey = new Map(incoming.map(item => [regexKey(item), item]));
  const result = current.map(item => incomingByKey.get(regexKey(item)) ?? item);
  const currentKeys = new Set(current.map(regexKey));
  for (const item of incoming) {
    if (!currentKeys.has(regexKey(item))) result.push(item);
  }
  return result;
}

function regexKey(value: unknown): string {
  const item = value as Record<string, unknown>;
  const identity = item.scriptName ?? item.name ?? item.id;
  return `${typeof identity}:${String(identity)}`;
}

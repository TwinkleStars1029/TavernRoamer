import type { EnvironmentPort } from '../../environment/EnvironmentPort';
import type { WorldBindingsSnapshot } from '../../environment/types';
import { getSillyTavernContext, getTavernGlobals } from '../host';
import { isPlainRecord, normalizeStringArray, readOptionalString, uniqueNonEmpty } from '../helpers';
import { parseEnvironmentSnapshot } from '../../environment/validation';
import { assertEnvironmentContext } from './context';

type WorldPort = Pick<EnvironmentPort, 'exportWorld' | 'applyWorld'>;

export function createWorldAdapter(): WorldPort {
  const globals = getTavernGlobals();
  return {
    async exportWorld() {
      const context = getSillyTavernContext();
      const raw = typeof context?.loadWorldInfo === 'function';
      if (!raw && typeof globals.getWorldbook !== 'function') throw new Error('Worldbook export API is unavailable');
      const bindings = await getWorldBindings(globals);
      const bookNames = uniqueNonEmpty([bindings.chat, bindings.char_primary, ...bindings.char_additional, ...bindings.global_enabled]);
      const books = Object.fromEntries(await Promise.all(bookNames.map(async name => {
        try {
          // Helper conversion calls .map() on optional raw key/keysecondary fields.
          // Preserve the original JSON, including extension fields and regex strings.
          const data: unknown = raw ? await context!.loadWorldInfo(name) : await globals.getWorldbook(name);
          if (raw ? !isRawWorldbook(data) : !Array.isArray(data)) {
            throw new Error('世界書資料不存在或格式不完整');
          }
          return [name, structuredClone(data)] as const;
        } catch (error) {
          throw new Error(`無法讀取世界書「${name}」：${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      })));
      return {
        kind: 'world', exportedAt: new Date().toISOString(), bindings, books,
        format: raw ? 'sillytavern-worldinfo-v1' : 'tavern-helper-worldbook-v1'
      };
    },
    async applyWorld(snapshot, contextKey) {
      snapshot = parseEnvironmentSnapshot('world', snapshot);
      assertEnvironmentContext(contextKey);
      if (snapshot.format === 'sillytavern-worldinfo-v1') {
        const context = getSillyTavernContext();
        if (typeof context?.saveWorldInfo !== 'function') throw new Error('Raw Worldbook restore API is unavailable');
        const books = Object.entries(snapshot.books);
        for (const [name, data] of books) {
          if (!isRawWorldbook(data)) throw new Error(`世界書「${name}」的備份格式不完整`);
        }
        for (const [name, data] of books) {
          assertEnvironmentContext(contextKey);
          await context.saveWorldInfo(name, structuredClone(data), true);
          assertEnvironmentContext(contextKey);
        }
        if (books.length > 0 && typeof context.updateWorldInfoList === 'function') await context.updateWorldInfoList();
        assertEnvironmentContext(contextKey);
        for (const [name] of books) {
          if (typeof context.reloadWorldInfoEditor === 'function') await context.reloadWorldInfoEditor(name);
          assertEnvironmentContext(contextKey);
        }
      } else {
        const createOrReplace = typeof globals.createOrReplaceWorldbook === 'function'
          ? globals.createOrReplaceWorldbook.bind(globals)
          : typeof globals.replaceWorldbook === 'function' ? globals.replaceWorldbook.bind(globals) : null;
        if (!createOrReplace) throw new Error('Worldbook restore API is unavailable');
        for (const [name, data] of Object.entries(snapshot.books)) {
          assertEnvironmentContext(contextKey);
          await createOrReplace(name, data);
          assertEnvironmentContext(contextKey);
        }
      }
      if (snapshot.bindings.chat && typeof globals.rebindChatWorldbook === 'function') {
        await globals.rebindChatWorldbook('current', snapshot.bindings.chat);
        assertEnvironmentContext(contextKey);
      }
    }
  };
}

async function getWorldBindings(globals: Record<string, any>): Promise<WorldBindingsSnapshot> {
  const chat = typeof globals.getChatWorldbookName === 'function' ? await globals.getChatWorldbookName('current') : null;
  const characterBindings: unknown = typeof globals.getCharWorldbookNames === 'function' ? await globals.getCharWorldbookNames('current') : null;
  const legacyBindings = normalizeStringArray(characterBindings);
  const globalEnabled = normalizeStringArray(typeof globals.getGlobalWorldbookNames === 'function' ? await globals.getGlobalWorldbookNames() : []);
  return {
    chat: readOptionalString(chat) ?? null,
    char_primary: isPlainRecord(characterBindings) ? normalizeStringArray(characterBindings.primary)[0] ?? null : legacyBindings[0] ?? null,
    char_additional: isPlainRecord(characterBindings) ? normalizeStringArray(characterBindings.additional) : legacyBindings.slice(1),
    global_enabled: globalEnabled
  };
}

function isRawWorldbook(value: unknown): boolean {
  return isPlainRecord(value) && isPlainRecord(value.entries) && Object.values(value.entries).every(isPlainRecord);
}

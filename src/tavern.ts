import type { TavernChatAdapter } from './chat/ChatSyncService';
import type {
  CharacterSnapshot,
  PersonaSnapshot,
  PresetSnapshot,
  RegexSnapshot,
  WorldBindingsSnapshot,
  WorldSnapshot,
} from './environment/types';
import { CHAT_META_KEY, type ChatSyncMeta, type TavernContext } from './types';

type ToastKind = 'info' | 'success' | 'warning' | 'error';

export type TavernApi = {
  isAvailable: () => boolean;
  getContext: (chatFileName?: string | null) => TavernContext;
  getChatMeta: () => ChatSyncMeta | null;
  writeChatMeta: (meta: ChatSyncMeta) => void;
  getChatAdapter: () => TavernChatAdapter;
  onChatChanged: (handler: (chatFileName: string | null) => void) => () => void;
  onMessageCompleted: (handler: () => void) => () => void;
  notify: (message: string, kind?: ToastKind) => void;
};

export function createTavernApi(): TavernApi {
  let currentChatFileName: string | null = null;

  return {
    isAvailable() {
      const globals = globalThis as Record<string, unknown>;
      return typeof globals.getVariables === 'function' || typeof globals.getCurrentCharacterName === 'function';
    },
    getContext(chatFileName = currentChatFileName) {
      currentChatFileName = chatFileName ?? currentChatFileName;
      const globals = globalThis as Record<string, any>;
      const meta = getChatMetaFromGlobals();
      return {
        characterName:
          typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null,
        characterId: typeof globals.getCurrentCharacterId === 'function' ? globals.getCurrentCharacterId() : null,
        chatFileName: currentChatFileName,
        chatId: meta?.chat_id ?? null,
        lastMessageId: typeof globals.getLastMessageId === 'function' ? globals.getLastMessageId() : null,
        status: 'unknown'
      };
    },
    getChatMeta() {
      return getChatMetaFromGlobals();
    },
    writeChatMeta(meta) {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.insertOrAssignVariables !== 'function') {
        throw new Error('酒館助手 chat 變數 API 不可用');
      }
      globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
    },
    getChatAdapter() {
      return createTavernChatAdapter();
    },
    onChatChanged(handler) {
      const globals = globalThis as Record<string, any>;
      const eventName = globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed';
      if (typeof globals.eventOn !== 'function') {
        return () => undefined;
      }
      const listener = (chatFileName: string | null) => {
        currentChatFileName = chatFileName ?? null;
        handler(currentChatFileName);
      };
      const subscription = globals.eventOn(eventName, listener);
      return () => {
        if (subscription && typeof subscription.stop === 'function') {
          subscription.stop();
        }
      };
    },
    onMessageCompleted(handler) {
      const globals = globalThis as Record<string, any>;
      const eventName = globals.tavern_events?.GENERATION_ENDED ?? globals.tavern_events?.MESSAGE_RECEIVED ?? 'generation_ended';
      if (typeof globals.eventOn !== 'function') {
        return () => undefined;
      }
      const subscription = globals.eventOn(eventName, handler);
      return () => {
        if (subscription && typeof subscription.stop === 'function') {
          subscription.stop();
        }
      };
    },
    notify(message, kind = 'info') {
      const globals = globalThis as Record<string, any>;
      const notifier = globals.toastr?.[kind];
      if (typeof notifier === 'function') {
        notifier(message);
        return;
      }
      console.log(`[TavernRoamer] ${message}`);
    }
  };
}

function createTavernChatAdapter(): TavernChatAdapter {
  const globals = globalThis as Record<string, any>;

  return {
    getChatVariables() {
      return typeof globals.getVariables === 'function' ? { ...globals.getVariables({ type: 'chat' }) } : {};
    },
    writeChatVariables(variables) {
      if (typeof globals.insertOrAssignVariables !== 'function') {
        throw new Error('酒館助手 chat 變數 API 不可用');
      }
      globals.insertOrAssignVariables(variables, { type: 'chat' });
    },
    getCurrentCharacterName() {
      return typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
    },
    getCurrentChatFileName() {
      return getCurrentRawChatInfo().displayFileName;
    },
    getMessages() {
      if (typeof globals.getChatMessages !== 'function') {
        throw new Error('酒館助手聊天訊息 API 不可用');
      }
      return globals.getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
    },
    getChatWorldbook() {
      return typeof globals.getChatWorldbookName === 'function' ? globals.getChatWorldbookName('current') : null;
    },
    async exportCharacter() {
      if (typeof globals.getCharacter !== 'function') {
        throw new Error('Character export API is unavailable');
      }
      const data = await globals.getCharacter('current');
      return {
        kind: 'character',
        exportedAt: new Date().toISOString(),
        characterName: this.getCurrentCharacterName(),
        data
      } satisfies CharacterSnapshot;
    },
    async exportWorld() {
      if (typeof globals.getWorldbook !== 'function') {
        throw new Error('Worldbook export API is unavailable');
      }
      const bindings = await getWorldBindings(globals);
      const bookNames = uniqueNonEmpty([
        bindings.chat,
        bindings.char_primary,
        ...bindings.char_additional,
        ...bindings.global_enabled
      ]);
      const books = Object.fromEntries(
        await Promise.all(bookNames.map(async name => [name, await globals.getWorldbook(name)] as const))
      );
      return {
        kind: 'world',
        exportedAt: new Date().toISOString(),
        bindings,
        books
      } satisfies WorldSnapshot;
    },
    async exportPersona() {
      if (typeof globals.getPersona !== 'function') {
        throw new Error('Persona export API is unavailable');
      }
      const data = await globals.getPersona('current');
      return {
        kind: 'persona',
        exportedAt: new Date().toISOString(),
        name: readOptionalString((data as Record<string, unknown> | null)?.name) ?? this.getCurrentCharacterName(),
        data
      } satisfies PersonaSnapshot;
    },
    async exportPreset() {
      const context = getSillyTavernContext();
      const manager = context?.getPresetManager?.('textgenerationwebui');
      const name =
        typeof manager?.getSelectedPresetName === 'function' ? manager.getSelectedPresetName() : null;
      if (!name || typeof manager?.getPresetSettings !== 'function') {
        throw new Error('Preset export API is unavailable');
      }
      return {
        kind: 'preset',
        exportedAt: new Date().toISOString(),
        name,
        data: manager.getPresetSettings(name)
      } satisfies PresetSnapshot;
    },
    async exportRegex() {
      if (typeof globals.getTavernRegexes !== 'function') {
        throw new Error('Regex export API is unavailable');
      }
      const items = await globals.getTavernRegexes({ type: 'global' });
      return {
        kind: 'regex',
        exportedAt: new Date().toISOString(),
        scope: 'global',
        items: Array.isArray(items) ? items : []
      } satisfies RegexSnapshot;
    },
    async applyCharacter(snapshot) {
      if (typeof globals.createOrReplaceCharacter !== 'function') {
        throw new Error('Character restore API is unavailable');
      }
      const targetName = snapshot.characterName ?? this.getCurrentCharacterName() ?? 'Imported Character';
      await globals.createOrReplaceCharacter(targetName, snapshot.data, { render: 'none' });
    },
    async applyWorld(snapshot) {
      if (typeof globals.replaceWorldbook !== 'function') {
        throw new Error('Worldbook restore API is unavailable');
      }
      for (const [name, data] of Object.entries(snapshot.books)) {
        await globals.replaceWorldbook(name, data);
      }
      if (snapshot.bindings.chat && typeof globals.rebindChatWorldbook === 'function') {
        await globals.rebindChatWorldbook('current', snapshot.bindings.chat);
      }
    },
    async applyPersona(snapshot) {
      const context = getSillyTavernContext();
      const personaApi = globals.createOrReplacePersona ?? context?.createOrReplacePersona;
      if (typeof personaApi !== 'function') {
        throw new Error('Persona restore API is unavailable');
      }
      const targetName = snapshot.name ?? 'Imported Persona';
      await personaApi(targetName, snapshot.data);
    },
    async applyPreset(snapshot) {
      const context = getSillyTavernContext();
      const manager = context?.getPresetManager?.('textgenerationwebui');
      if (!snapshot.name || typeof manager?.savePreset !== 'function') {
        throw new Error('Preset restore API is unavailable');
      }
      await manager.savePreset(snapshot.name, snapshot.data, { skipUpdate: false });
      const selectedValue = findPresetOptionValue(manager, snapshot.name);
      if (selectedValue !== null && typeof manager.selectPreset === 'function') {
        manager.selectPreset(selectedValue);
      }
    },
    async applyRegex(snapshot) {
      if (typeof globals.replaceTavernRegexes !== 'function') {
        throw new Error('Regex restore API is unavailable');
      }
      await globals.replaceTavernRegexes(Array.isArray(snapshot.items) ? snapshot.items : [], { type: snapshot.scope });
    },
    async exportRawChat() {
      const chatInfo = getCurrentRawChatInfo();
      const response = await fetch('/api/chats/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
          file: chatInfo.fileName,
          avatar_url: chatInfo.avatarUrl,
          exportfilename: chatInfo.fileName,
          format: 'jsonl',
          is_group: false
        }),
        cache: 'no-cache'
      });
      if (!response.ok) {
        throw new Error(`SillyTavern raw chat export failed: ${response.status}`);
      }
      const result = await response.json() as { result?: unknown; message?: unknown };
      if (typeof result.result !== 'string') {
        throw new Error(typeof result.message === 'string' ? result.message : 'SillyTavern raw chat export did not return JSONL');
      }
      return {
        content: result.result,
        messageCount: countRawChatMessages(result.result)
      };
    },
    async replaceRawChat(content) {
      const chatInfo = getCurrentRawChatInfo();
      const response = await fetch('/api/chats/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
          avatar_url: chatInfo.avatarUrl,
          file_name: chatInfo.chatId,
          chat: parseRawChatMessages(content),
          force: true
        }),
        cache: 'no-cache'
      });
      if (!response.ok) {
        throw new Error(`SillyTavern raw chat save failed: ${response.status}`);
      }
      await getSillyTavernContext()?.reloadCurrentChat?.();
    },
    async replaceChat(chatPackage) {
      if (typeof globals.deleteChatMessages !== 'function' || typeof globals.createChatMessages !== 'function') {
        throw new Error('酒館助手聊天覆寫 API 不可用');
      }
      const lastMessageId = typeof globals.getLastMessageId === 'function' ? globals.getLastMessageId() : -1;
      if (lastMessageId >= 0) {
        await globals.deleteChatMessages(
          Array.from({ length: lastMessageId + 1 }, (_value, index) => index),
          { refresh: 'none' }
        );
      }
      await globals.createChatMessages(
        chatPackage.messages.map(message => toCreatableChatMessage(message)),
        { insert_before: 'end', refresh: 'all' }
      );
      if (typeof globals.setChatMessages === 'function') {
        await globals.setChatMessages(
          chatPackage.messages.map((message, index) => toRestorableChatMessage(message, index)),
          { refresh: 'all' }
        );
      }
      if (chatPackage.chat_worldbook && typeof globals.rebindChatWorldbook === 'function') {
        await globals.rebindChatWorldbook('current', chatPackage.chat_worldbook);
      }
      if (typeof globals.replaceVariables === 'function') {
        globals.replaceVariables(chatPackage.chat_variables, { type: 'chat' });
      } else if (typeof globals.insertOrAssignVariables === 'function') {
        globals.insertOrAssignVariables(chatPackage.chat_variables, { type: 'chat' });
      }
    }
  };
}

async function getWorldBindings(globals: Record<string, any>): Promise<WorldBindingsSnapshot> {
  const chat = typeof globals.getChatWorldbookName === 'function' ? await globals.getChatWorldbookName('current') : null;
  const characterBindings = normalizeStringArray(
    typeof globals.getCharWorldbookNames === 'function' ? await globals.getCharWorldbookNames('current') : []
  );
  const globalEnabled = normalizeStringArray(
    typeof globals.getGlobalWorldbookNames === 'function' ? await globals.getGlobalWorldbookNames() : []
  );
  return {
    chat: readOptionalString(chat) ?? null,
    char_primary: characterBindings[0] ?? null,
    char_additional: characterBindings.slice(1),
    global_enabled: globalEnabled
  };
}

function getCurrentRawChatInfo(): { chatId: string; fileName: string; displayFileName: string; avatarUrl: string } {
  const context = getSillyTavernContext();
  const chatId = readOptionalString(context?.getCurrentChatId?.()) ?? readOptionalString(context?.chatId);
  const contextFileName =
    readOptionalString(context?.chatFileName) ??
    readOptionalString(context?.chat_file_name) ??
    readOptionalString(context?.chat?.file_name);
  const characterId = readOptionalString(context?.characterId);
  const characterIndex = characterId === undefined ? Number.NaN : Number(characterId);
  const character =
    Array.isArray(context?.characters) && Number.isInteger(characterIndex) ? context.characters[characterIndex] : null;
  const avatarUrl = readOptionalString(character?.avatar);
  if (!chatId || !avatarUrl) {
    throw new Error('無法取得目前 SillyTavern 原始聊天檔資訊');
  }
  return {
    chatId,
    fileName: chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`,
    displayFileName: contextFileName ?? (chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`),
    avatarUrl
  };
}

function getSillyTavernContext(): Record<string, any> | null {
  const candidates = [globalThis as Record<string, any>, safeParentWindow()].filter(Boolean) as Array<Record<string, any>>;
  for (const candidate of candidates) {
    const provider = candidate.SillyTavern;
    const context = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
    if (context && typeof context === 'object') {
      return context;
    }
  }
  return null;
}

function safeParentWindow(): Record<string, any> | null {
  try {
    const currentWindow = globalThis as unknown as Window;
    return currentWindow.parent && currentWindow.parent !== currentWindow
      ? currentWindow.parent as unknown as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function getRequestHeaders(): Record<string, string> {
  const headers = getSillyTavernContext()?.getRequestHeaders?.();
  if (headers && typeof headers === 'object') {
    return headers as Record<string, string>;
  }
  return { 'Content-Type': 'application/json' };
}

function findPresetOptionValue(manager: { getSelectedPreset?: () => unknown; getAllPresets?: () => unknown[]; findPreset?: (name: string) => unknown }, name: string): string | null {
  if (typeof manager.findPreset === 'function') {
    const found = manager.findPreset(name);
    return typeof found === 'string' ? found : null;
  }
  const selected = manager.getSelectedPreset?.();
  return typeof selected === 'string' ? selected : null;
}

function parseRawChatMessages(content: string): Array<Record<string, unknown>> {
  return content
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function countRawChatMessages(content: string): number {
  const messages = parseRawChatMessages(content);
  if (messages.length === 0) {
    return 0;
  }
  const first = messages[0] ?? {};
  if (first.user_name !== undefined || first.name !== undefined || first.chat_metadata !== undefined) {
    return Math.max(0, messages.length - 1);
  }
  return messages.length;
}

function toCreatableChatMessage(message: Record<string, unknown>): Record<string, unknown> {
  const current = currentSwipeSnapshot(message);
  return omitUndefined({
    name: readOptionalString(message.name),
    role: normalizeMessageRole(message),
    is_hidden: readOptionalBoolean(message.is_hidden),
    message: current.message,
    data: current.data,
    extra: current.extra
  });
}

function toRestorableChatMessage(message: Record<string, unknown>, index: number): Record<string, unknown> {
  const current = currentSwipeSnapshot(message);
  return omitUndefined({
    ...message,
    message_id: index,
    message: current.message,
    data: current.data,
    extra: current.extra
  });
}

function currentSwipeSnapshot(message: Record<string, unknown>): {
  message: string;
  data: Record<string, unknown> | undefined;
  extra: Record<string, unknown> | undefined;
} {
  const swipes = Array.isArray(message.swipes) ? message.swipes : [];
  const swipeId = clampSwipeId(Number(message.swipe_id ?? 0), swipes.length);
  const swipedMessage = typeof swipes[swipeId] === 'string' ? swipes[swipeId] : undefined;
  const messageText = readOptionalString(message.message) ?? readOptionalString(message.mes) ?? swipedMessage ?? '';
  const swipesData = Array.isArray(message.swipes_data) ? message.swipes_data : [];
  const swipesInfo = Array.isArray(message.swipes_info) ? message.swipes_info : [];
  return {
    message: messageText,
    data: readOptionalRecord(message.data) ?? readOptionalRecord(swipesData[swipeId]),
    extra: readOptionalRecord(message.extra) ?? readOptionalRecord(swipesInfo[swipeId])
  };
}

function normalizeMessageRole(message: Record<string, unknown>): 'system' | 'assistant' | 'user' {
  if (message.role === 'system' || message.role === 'assistant' || message.role === 'user') {
    return message.role;
  }
  if (message.is_user === true) {
    return 'user';
  }
  if (message.is_system === true) {
    return 'system';
  }
  return 'assistant';
}

function clampSwipeId(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0) {
    return 0;
  }
  return Math.min(value, Math.max(0, length - 1));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value];
  }
  return [];
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function getChatMetaFromGlobals(): ChatSyncMeta | null {
  const globals = globalThis as Record<string, any>;
  if (typeof globals.getVariables !== 'function') {
    return null;
  }
  const variables = globals.getVariables({ type: 'chat' });
  const meta = variables?.[CHAT_META_KEY];
  if (!isChatMeta(meta)) {
    return null;
  }
  return meta;
}

function isChatMeta(value: unknown): value is ChatSyncMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Record<string, unknown>;
  return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string';
}

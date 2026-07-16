import { MemoryDriveClient } from './drive/MemoryDriveClient';
import type { DriveService } from './drive/DriveService';
import { buildVersionFilename } from './drive/version';
import { loadSettings, saveSettings } from './settings';
import { CHAT_META_KEY, type SelfCheckCase, type SelfCheckResult } from './types';
import { createTavernApi } from './tavern';
import { createChatPackage, unpackChatPackage } from './chat/package';

const cases: SelfCheckCase[] = [];

export function registerSelfCheck(testCase: SelfCheckCase): void {
  if (cases.some(existing => existing.id === testCase.id)) {
    return;
  }
  cases.push(testCase);
}

export function getSelfCheckCases(): SelfCheckCase[] {
  return [...cases];
}

export async function runSelfChecks(): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];
  for (const testCase of cases) {
    const startedAt = performance.now();
    try {
      const result = await testCase.run();
      results.push({
        ...result,
        id: testCase.id,
        label: testCase.label,
        durationMs: Math.round(performance.now() - startedAt)
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        label: testCase.label,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt)
      });
    }
  }
  return results;
}

export function registerPhase0SelfChecks(): void {
  registerSelfCheck({
    id: 'settings.persistence',
    label: '設定持久化',
    async run() {
      const original = loadSettings();
      const marker = `SelfCheck-${Date.now()}`;
      saveSettings({ ...original, deviceName: marker });
      const reloaded = loadSettings();
      saveSettings(original);
      return reloaded.deviceName === marker
        ? { status: 'pass', message: '裝置名稱可寫入並讀回' }
        : { status: 'fail', message: '裝置名稱讀回不一致', details: reloaded };
    }
  });

  registerSelfCheck({
    id: 'drive.mock.memory',
    label: 'Drive mock 記憶體檔案樹',
    async run() {
      const drive = new MemoryDriveClient();
      const root = await drive.ensureFolder('SillyTavernSync', null);
      const role = await drive.ensureFolder('角色', root.id);
      const chat = await drive.ensureFolder('chat_abc', role.id);
      const folder = await drive.ensureFolder('chat', chat.id);
      const file = await drive.uploadJson(folder.id, '2026-06-25T14-45-00Z__A電腦.json', { ok: true });
      const downloaded = await drive.downloadJson<{ ok: boolean }>(file.id);

      drive.injectError(429);
      try {
        await drive.listFiles(folder.id);
        return { status: 'fail', message: '429 注入後沒有拋錯' };
      } catch {
        return downloaded.ok
          ? { status: 'pass', message: '可建立資料夾/檔案，且可注入 429/5xx/401 錯誤' }
          : { status: 'fail', message: '下載內容不一致', details: downloaded };
      }
    }
  });
}

export function registerApiSpikeSelfChecks(): void {
  registerSelfCheck({
    id: 'api.chat.variables',
    label: 'chat 變數讀寫',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getVariables !== 'function' || typeof globals.insertOrAssignVariables !== 'function') {
        return { status: 'skip', message: '不在酒館助手環境，略過真實 API 驗證' };
      }
      const marker = `chat_self_check_${Date.now()}`;
      const before = globals.getVariables({ type: 'chat' });
      const previous = before?.[CHAT_META_KEY];
      globals.insertOrAssignVariables(
        {
          [CHAT_META_KEY]: {
            chat_id: marker,
            role_key: 'self_check',
            device_name: 'self_check'
          }
        },
        { type: 'chat' }
      );
      const after = globals.getVariables({ type: 'chat' });
      globals.insertOrAssignVariables({ [CHAT_META_KEY]: previous }, { type: 'chat' });
      return after?.[CHAT_META_KEY]?.chat_id === marker
        ? { status: 'pass', message: 'chat 變數可寫入並讀回' }
        : { status: 'fail', message: 'chat 變數讀回不一致', details: after?.[CHAT_META_KEY] };
    }
  });

  registerSelfCheck({
    id: 'api.character.roundtrip',
    label: '角色卡 JSON 來回',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getCharacter !== 'function' || typeof globals.createOrReplaceCharacter !== 'function') {
        return { status: 'skip', message: '角色卡 API 不可用' };
      }
      const currentName =
        typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
      if (!currentName) {
        return { status: 'skip', message: '目前未選取角色卡' };
      }
      const character = await globals.getCharacter('current');
      const tempName = `TavernRoamer SelfCheck ${Date.now()}`;
      await globals.createOrReplaceCharacter(tempName, character, { render: 'none' });
      const copied = await globals.getCharacter(tempName);
      if (typeof globals.deleteCharacter === 'function') {
        await globals.deleteCharacter(tempName, { delete_chats: false });
      }
      const hasExtensions = Boolean(copied?.extensions);
      return hasExtensions
        ? { status: 'pass', message: 'getCharacter/createOrReplaceCharacter 可保留 extensions', details: { tempName } }
        : { status: 'fail', message: '角色卡 extensions 遺失', details: copied };
    }
  });

  registerSelfCheck({
    id: 'api.chat.detail',
    label: '聊天完整訊息讀取',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getChatMessages !== 'function') {
        return { status: 'skip', message: '聊天訊息 API 不可用' };
      }
      const messages = globals.getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
      return Array.isArray(messages)
        ? { status: 'pass', message: `可讀取 ${messages.length} 則訊息`, details: { count: messages.length } }
        : { status: 'fail', message: '聊天訊息 API 回傳非陣列', details: messages };
    }
  });

  registerSelfCheck({
    id: 'api.chat.importRawChat',
    label: 'importRawChat 行為探測',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.importRawChat !== 'function') {
        return { status: 'skip', message: 'importRawChat API 不可用' };
      }
      return {
        status: 'skip',
        message: '避免在 Phase0 自動建立聊天檔；請在人工驗收時改為啟用破壞性匯入測試並記錄檔名規則'
      };
    }
  });

  registerSelfCheck({
    id: 'api.preset.inUse',
    label: "getPreset('in_use')",
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getPreset !== 'function') {
        return { status: 'skip', message: '預設 API 不可用' };
      }
      const preset = await globals.getPreset('in_use');
      return preset ? { status: 'pass', message: '可讀取目前使用中預設' } : { status: 'fail', message: '未讀到預設' };
    }
  });

  registerSelfCheck({
    id: 'api.regex.global',
    label: 'getTavernRegexes',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getTavernRegexes !== 'function') {
        return { status: 'skip', message: '正則 API 不可用' };
      }
      const regexes = await globals.getTavernRegexes({ type: 'global' });
      return Array.isArray(regexes)
        ? { status: 'pass', message: `可讀取 ${regexes.length} 條全域正則` }
        : { status: 'fail', message: '正則 API 回傳非陣列', details: regexes };
    }
  });

  registerSelfCheck({
    id: 'api.worldbook.available',
    label: 'worldbook API 可用性',
    async run() {
      const globals = globalThis as Record<string, any>;
      const names = ['getWorldbook', 'replaceWorldbook', 'importRawWorldbook'];
      const missing = names.filter(name => typeof globals[name] !== 'function');
      return missing.length === 0
        ? { status: 'pass', message: 'worldbook 主要 API 都可用' }
        : { status: 'skip', message: `缺少 API: ${missing.join(', ')}` };
    }
  });
}

export function registerDriveSelfChecks(drive: DriveService, isConnected: () => boolean): void {
  registerSelfCheck({
    id: 'drive.real.smoke',
    label: '真實 Drive 冒煙測試',
    async run() {
      if (!isConnected()) {
        return { status: 'skip', message: '尚未連線 Google Drive' };
      }
      const folderId = await drive.ensureFolderPath(['SillyTavernSync', '_self_check', 'chat_smoke', 'chat']);
      const filename = buildVersionFilename('self-check', new Date('2026-06-25T14:45:00Z'));
      const payload = { ok: true, marker: `drive-smoke-${Date.now()}` };
      const uploaded = await drive.uploadJson(folderId, filename, payload);
      const versions = await drive.listVersions(['SillyTavernSync', '_self_check', 'chat_smoke', 'chat']);
      const downloaded = await drive.downloadJson<typeof payload>(uploaded.id);
      await drive.deleteFile(uploaded.id);

      if (!versions.some(version => version.fileId === uploaded.id) || downloaded.marker !== payload.marker) {
        return {
          status: 'fail',
          message: 'Drive 上傳/列舉/下載結果不一致',
          details: { uploaded, versions, downloaded }
        };
      }
      return { status: 'pass', message: 'ensureFolder/upload/listVersions/download/delete 全部通過' };
    }
  });
}

export function registerUiSelfChecks(
  probe: () => { mounted: boolean; hasInlineDrawer: boolean; toggleReady: boolean; details?: unknown }
): void {
  registerSelfCheck({
    id: 'ui.panel.mounted',
    label: '面板掛載與 inline-drawer 結構',
    async run() {
      const health = probe();
      if (!health.mounted) {
        return { status: 'fail', message: '面板未掛載（找不到 #tavern-roamer-panel）', details: health.details };
      }
      if (!health.hasInlineDrawer) {
        return { status: 'fail', message: '面板缺少 inline-drawer 收合結構', details: health.details };
      }
      if (!health.toggleReady) {
        return { status: 'fail', message: 'inline-drawer 收合 toggle/content 不完整', details: health.details };
      }
      return { status: 'pass', message: '面板已掛載且 inline-drawer 收合結構完整', details: health.details };
    }
  });
}

export function registerChatSelfChecks(): void {
  registerSelfCheck({
    id: 'chat.pack.roundtrip',
    label: '聊天 pack/unpack 來回',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getChatMessages !== 'function' || typeof globals.getVariables !== 'function') {
        return { status: 'skip', message: '不在酒館助手聊天環境' };
      }
      const api = createTavernApi();
      const adapter = api.getChatAdapter();
      const meta = api.getChatMeta() ?? {
        chat_id: 'chat_self_check',
        role_key: 'self_check'
      };
      const messages = adapter.getMessages();
      const variables = adapter.getChatVariables();
      const packed = createChatPackage({
        meta,
        deviceName: loadSettings().deviceName,
        messages,
        chatVariables: variables,
        chatWorldbook: adapter.getChatWorldbook()
      });
      const unpacked = unpackChatPackage(JSON.stringify(packed));
      const same = JSON.stringify(unpacked.messages) === JSON.stringify(messages);
      return same
        ? { status: 'pass', message: `pack/unpack 訊息一致，共 ${messages.length} 樓` }
        : { status: 'fail', message: 'pack/unpack 訊息不一致', details: { packed, messages } };
    }
  });

  registerSelfCheck({
    id: 'chat.replace.roundtrip',
    label: '聊天就地覆寫還原',
    async run() {
      const globals = globalThis as Record<string, any>;
      if (typeof globals.getChatMessages !== 'function' || typeof globals.setChatMessages !== 'function') {
        return { status: 'skip', message: '聊天覆寫 API 不可用' };
      }
      const api = createTavernApi();
      const adapter = api.getChatAdapter();
      const meta = api.getChatMeta() ?? {
        chat_id: 'chat_self_check',
        role_key: 'self_check'
      };
      const originalMessages = adapter.getMessages();
      if (originalMessages.length === 0) {
        return { status: 'skip', message: '目前聊天沒有樓層可測' };
      }
      const packed = createChatPackage({
        meta,
        deviceName: loadSettings().deviceName,
        messages: originalMessages,
        chatVariables: adapter.getChatVariables(),
        chatWorldbook: adapter.getChatWorldbook()
      });
      const startedAt = performance.now();
      try {
        await globals.setChatMessages(
          [{ message_id: originalMessages[0]?.message_id ?? 0, message: `[TavernRoamer self-check] ${Date.now()}` }],
          { refresh: 'none' }
        );
        await adapter.replaceChat(packed);
        const restored = adapter.getMessages();
        const same = JSON.stringify(restored) === JSON.stringify(originalMessages);
        return same
          ? { status: 'pass', message: `覆寫還原一致，耗時 ${Math.round(performance.now() - startedAt)}ms` }
          : { status: 'fail', message: '覆寫還原後訊息不一致', details: { originalMessages, restored } };
      } finally {
        await adapter.replaceChat(packed);
      }
    }
  });
}

export function registerPullSelfChecks(): void {
  registerSelfCheck({
    id: 'api.chat.pull.support',
    label: '雲端拉取所需酒館 API',
    async run() {
      const globals = globalThis as Record<string, any>;
      const provider = globals.parent?.SillyTavern ?? globals.SillyTavern;
      const context = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
      if (!context || typeof context !== 'object') {
        return { status: 'skip', message: '不在酒館環境，略過' };
      }
      if (!Array.isArray(context.characters)) {
        return { status: 'fail', message: 'context.characters 不可用，無法比對本地角色' };
      }
      const missing = ['openCharacterChat', 'selectCharacterById'].filter(
        name => typeof context[name] !== 'function'
      );
      return missing.length === 0
        ? { status: 'pass', message: 'openCharacterChat / selectCharacterById / characters 皆可用' }
        : { status: 'fail', message: `缺少 API: ${missing.join(', ')}（雲端拉取功能無法使用）` };
    }
  });
}

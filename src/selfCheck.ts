import { loadUploadQueue } from './chat/queue';
import type { TavernShellPort } from './app/TavernShellPort';
import type { TavernDiagnosticsPort } from './app/TavernDiagnosticsPort';
import type { ChatPullPort } from './chat/ports/ChatPullPort';
import type { ChatSyncPort } from './chat/ports/ChatSyncPort';
import type { DriveService } from './drive/DriveService';
import type { EnvironmentExportPort } from './environment/EnvironmentPort';
import type { EnvironmentItemKind, EnvironmentSnapshot } from './environment/types';
import { parseEnvironmentSnapshot } from './environment/validation';
import { loadSettings, readScriptVariable } from './settings';
import {
  SETTINGS_KEY,
  type DriveConnectionState,
  type SelfCheckCase,
  type SelfCheckMode,
  type SelfCheckResult
} from './types';
import { createChatPackage } from './chat/package';
import { buildVersionFilename } from './drive/version';

const cases: SelfCheckCase[] = [];
const DEFAULT_TIMEOUT_MS = 12_000;
let activeRun: Promise<SelfCheckResult[]> | null = null;

export type SelfCheckTavernPorts = {
  shell: TavernShellPort;
  chatSync: ChatSyncPort;
  chatPull: ChatPullPort;
  environment: EnvironmentExportPort;
  diagnostics: TavernDiagnosticsPort;
};

export type SelfCheckProgress = {
  phase: 'start' | 'complete';
  completed: number;
  total: number;
  currentId: string;
  currentLabel: string;
  result?: SelfCheckResult;
};

export type RunSelfChecksOptions = {
  mode?: SelfCheckMode;
  onProgress?: (event: SelfCheckProgress) => void;
};

export function registerSelfCheck(testCase: SelfCheckCase): void {
  if (cases.some(existing => existing.id === testCase.id)) {
    return;
  }
  cases.push(testCase);
}

export function getSelfCheckCases(mode?: SelfCheckMode): SelfCheckCase[] {
  return cases.filter(testCase => !mode || testCase.mode === mode).map(testCase => ({ ...testCase }));
}

export function runSelfChecks(options: RunSelfChecksOptions = {}): Promise<SelfCheckResult[]> {
  if (activeRun) {
    return activeRun;
  }
  const selected = getSelfCheckCases(options.mode ?? 'quick');
  const run = executeSelfChecks(selected, options.onProgress);
  const wrapped = run.finally(() => {
    if (activeRun === wrapped) activeRun = null;
  });
  activeRun = wrapped;
  return wrapped;
}

async function executeSelfChecks(
  selected: SelfCheckCase[],
  onProgress?: (event: SelfCheckProgress) => void
): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];
  for (const [index, testCase] of selected.entries()) {
    onProgress?.({
      phase: 'start',
      completed: index,
      total: selected.length,
      currentId: testCase.id,
      currentLabel: testCase.label
    });
    const result = await executeCase(testCase);
    results.push(result);
    onProgress?.({
      phase: 'complete',
      completed: index + 1,
      total: selected.length,
      currentId: testCase.id,
      currentLabel: testCase.label,
      result
    });
  }
  return results;
}

async function executeCase(testCase: SelfCheckCase): Promise<SelfCheckResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await withTimeout(testCase.run(), testCase.timeoutMs ?? DEFAULT_TIMEOUT_MS, testCase.label);
    return {
      ...result,
      id: testCase.id,
      label: testCase.label,
      category: testCase.category,
      safety: testCase.safety,
      mode: testCase.mode,
      startedAt,
      durationMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      id: testCase.id,
      label: testCase.label,
      category: testCase.category,
      safety: testCase.safety,
      mode: testCase.mode,
      status: 'fail',
      message: errorMessage(error),
      remediation: '請重試；若持續失敗，請複製診斷報告並確認酒館助手版本。',
      startedAt,
      durationMs: Math.round(performance.now() - started)
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}逾時（${timeoutMs}ms）`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function registerPhase0SelfChecks(): void {
  registerSelfCheck({
    id: 'settings.valid',
    label: '同步設定',
    category: 'settings',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const settings = loadSettings();
      const stored = readScriptVariable(SETTINGS_KEY);
      const details = {
        configured: Boolean(stored),
        hasGoogleClientId: Boolean(settings.googleClientId.trim()),
        deviceName: settings.deviceName,
        autoSyncEnabled: settings.autoSyncEnabled,
        autoSyncEveryN: settings.autoSyncEveryN,
        retentionMode: settings.chatRetention.mode,
        retentionLatestN: settings.chatRetention.latestN
      };
      if (!settings.googleClientId.trim()) {
        return {
          status: 'blocked',
          message: '尚未設定 Google Client ID',
          remediation: '請在設定頁填入 Google Client ID。',
          action: 'open_settings',
          details
        };
      }
      if (!settings.deviceName.trim() || settings.autoSyncEveryN < 1) {
        return {
          status: 'fail',
          message: '裝置名稱或自動同步間隔無效',
          remediation: '請修正同步設定後重新檢查。',
          action: 'open_settings',
          details
        };
      }
      return { status: 'pass', message: '設定格式正確', details };
    }
  });
}

export function registerApiSpikeSelfChecks(tavern: SelfCheckTavernPorts): void {
  for (const kind of ['character', 'world', 'persona', 'preset', 'regex'] as EnvironmentItemKind[]) {
    registerSelfCheck(createEnvironmentExportCase(tavern.environment, kind));
  }
  for (const kind of ['character', 'world', 'persona', 'preset', 'regex'] as EnvironmentItemKind[]) {
    registerSelfCheck(createEnvironmentRestoreCapabilityCase(tavern.diagnostics, kind));
  }
  registerAdvancedCharacterRoundtrip(tavern.diagnostics);
}

function createEnvironmentExportCase(adapter: EnvironmentExportPort, kind: EnvironmentItemKind): SelfCheckCase {
  return {
    id: `environment.export.${kind}`,
    label: `${environmentLabel(kind)}備份資料`,
    category: 'environment_backup',
    safety: 'read_only',
    mode: 'quick',
    timeoutMs: kind === 'world' ? 20_000 : DEFAULT_TIMEOUT_MS,
    async run() {
      let snapshot: EnvironmentSnapshot;
      try {
        snapshot = await exportEnvironmentSnapshot(adapter, kind);
      } catch (error) {
        if (isMissingSelectionError(error)) {
          return blockedForChat(environmentSelectionRemediation(kind));
        }
        throw error;
      }
      const validation = validateEnvironmentSnapshot(snapshot, kind);
      return validation
        ? { status: 'pass', message: validation, details: summarizeSnapshot(snapshot) }
        : {
            status: 'fail',
            message: `${environmentLabel(kind)}備份資料格式不完整`,
            remediation: '請確認酒館助手 API 與目前選取的資料。',
            details: summarizeSnapshot(snapshot)
          };
    }
  };
}

function createEnvironmentRestoreCapabilityCase(diagnostics: TavernDiagnosticsPort, kind: EnvironmentItemKind): SelfCheckCase {
  return {
    id: `environment.restore.${kind}`,
    label: `${environmentLabel(kind)}還原能力`,
    category: 'environment_restore',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const missing = diagnostics.environmentRestoreMissing(kind);
      return missing.length === 0
        ? { status: 'pass', message: '必要的還原 API 可用' }
        : {
            status: 'fail',
            message: `缺少 API：${missing.join(', ')}`,
            remediation: '請更新酒館助手或確認目前 SillyTavern 版本相容。',
            details: { missing }
          };
    }
  };
}

function registerAdvancedCharacterRoundtrip(diagnostics: TavernDiagnosticsPort): void {
  registerSelfCheck({
    id: 'advanced.character.roundtrip',
    label: '角色卡暫存副本來回',
    category: 'advanced',
    safety: 'destructive',
    mode: 'advanced',
    timeoutMs: 30_000,
    async run() {
      const probe = await diagnostics.characterRoundtrip();
      if (!probe.supported) {
        return {
          status: 'not_applicable',
          message: '缺少可安全建立並刪除暫存角色卡的 API',
          remediation: '此進階案例不會執行，以避免留下測試資料。'
        };
      }
      if (!probe.selected) return blockedForChat('請先選擇專用測試角色。');
      if (probe.cleanupError) {
        return {
          status: 'fail',
          message: `暫存角色卡清理失敗：${probe.cleanupError}`,
          remediation: `請手動刪除角色卡「${probe.tempName}」。`,
          details: { tempName: probe.tempName, cleanupError: probe.cleanupError }
        };
      }
      return probe.copiedExtensions
        ? { status: 'pass', message: '暫存角色卡建立、讀回、欄位驗證與清理成功' }
        : {
            status: 'fail',
            message: '暫存角色卡的 extensions 遺失',
            remediation: '請勿使用角色卡還原功能，並檢查宿主 API 相容性。'
          };
    }
  });
}

export function registerDriveSelfChecks(
  drive: DriveService,
  getState: () => DriveConnectionState
): void {
  registerSelfCheck({
    id: 'drive.connection',
    label: 'Google Drive 連線',
    category: 'drive',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const state = getState();
      return state.connected
        ? { status: 'pass', message: `已連線${state.email ? `：${state.email}` : ''}` }
        : {
            status: 'blocked',
            message: state.error ? `尚未連線：${state.error}` : '尚未連線 Google Drive',
            remediation: '請先完成 Google Drive 授權。',
            action: 'connect_drive'
          };
    }
  });

  registerSelfCheck({
    id: 'drive.real.smoke',
    label: 'Drive 暫存檔讀寫與清理',
    category: 'drive',
    safety: 'temporary_write',
    mode: 'quick',
    timeoutMs: 30_000,
    async run() {
      if (!getState().connected) {
        return {
          status: 'blocked',
          message: '尚未連線，未建立任何暫存檔',
          remediation: '請先連線 Google Drive。',
          action: 'connect_drive'
        };
      }
      const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const path = ['SillyTavernSync', '_self_check', runId];
      // listVersions 只列出正式版本命名格式；自檢也使用相同格式，才能驗證實際產品路徑。
      const filename = buildVersionFilename('_self_check');
      const payload = { ok: true, marker: runId };
      let folderId: string | null = null;
      let fileId: string | null = null;
      let primaryError: string | null = null;
      const cleanupErrors: string[] = [];
      try {
        folderId = await drive.ensureFolderPath(path);
        const uploaded = await drive.uploadJson(folderId, filename, payload);
        fileId = uploaded.id;
        const versions = await drive.listVersions(folderId);
        const downloaded = await drive.downloadJson<typeof payload>(fileId);
        if (!versions.some(version => version.fileId === fileId) || downloaded.marker !== payload.marker) {
          throw new Error('Drive 上傳、列舉或下載內容不一致');
        }
      } catch (error) {
        primaryError = errorMessage(error);
      } finally {
        if (fileId) {
          try {
            await drive.deleteFile(fileId);
            fileId = null;
          } catch (error) {
            cleanupErrors.push(`檔案清理失敗：${errorMessage(error)}`);
          }
        }
        if (folderId && !fileId) {
          try {
            await drive.deleteFile(folderId);
            folderId = null;
          } catch (error) {
            cleanupErrors.push(`資料夾清理失敗：${errorMessage(error)}`);
          }
        }
      }
      if (primaryError || cleanupErrors.length > 0) {
        return {
          status: 'fail',
          message: primaryError ?? cleanupErrors.join('；'),
          remediation: cleanupErrors.length > 0
            ? `請到 Google Drive 檢查 ${path.join('/')} 並刪除殘留暫存資料。`
            : '請確認網路與 Google Drive 授權後重試。',
          details: { path, primaryError, cleanupErrors, remainingFileId: fileId, remainingFolderId: folderId }
        };
      }
      return { status: 'pass', message: '上傳、列舉、下載與清理全部完成', details: { path } };
    }
  });

  registerSelfCheck({
    id: 'autosync.readiness',
    label: '自動同步前置條件',
    category: 'autosync',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const settings = loadSettings();
      if (!settings.autoSyncEnabled) {
        return { status: 'not_applicable', message: '自動同步目前已停用' };
      }
      if (!getState().connected) {
        return {
          status: 'blocked',
          message: '自動同步已啟用，但 Google Drive 尚未連線',
          remediation: '請連線 Google Drive，否則新訊息只能等待之後補傳。',
          action: 'connect_drive'
        };
      }
      return { status: 'pass', message: `已啟用，每 ${settings.autoSyncEveryN} 則訊息同步一次` };
    }
  });
}

export function registerChatSelfChecks(tavern: SelfCheckTavernPorts): void {
  registerSelfCheck({
    id: 'chat.context.ready',
    label: '目前角色與聊天',
    category: 'chat',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const context = tavern.shell.getContext();
      let chatFileName: string | null = null;
      try {
        chatFileName = tavern.chatSync.getCurrentChatFileName();
      } catch {
        // 缺少目前聊天時統一回 blocked，避免把使用狀態誤判為 API 故障。
      }
      if (!context.characterName || !chatFileName) {
        return blockedForChat('請先選擇一個角色並開啟聊天。');
      }
      return {
        status: 'pass',
        message: `${context.characterName}／${chatFileName}`,
        details: { characterName: context.characterName, chatFileName, chatId: context.chatId }
      };
    }
  });

  registerSelfCheck({
    id: 'chat.readable',
    label: '聊天訊息、swipes 與變數',
    category: 'chat',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const missing = tavern.diagnostics.chatReadMissing();
      if (missing.length > 0) return missingApi(missing);
      const adapter = tavern.chatSync;
      const messages = adapter.getMessages();
      const variables = adapter.getChatVariables();
      if (!Array.isArray(messages) || typeof variables !== 'object' || variables === null) {
        return {
          status: 'fail',
          message: '聊天訊息或變數格式不正確',
          remediation: '請更新酒館助手並重新整理頁面。'
        };
      }
      const swipeCount = messages.filter(message => Array.isArray((message as Record<string, unknown>).swipes)).length;
      return {
        status: 'pass',
        message: `可讀取 ${messages.length} 則訊息，${swipeCount} 則含 swipes`,
        details: { messageCount: messages.length, swipeCount, variableKeys: Object.keys(variables) }
      };
    }
  });

  registerSelfCheck({
    id: 'chat.raw_export',
    label: '目前聊天原始匯出',
    category: 'chat',
    safety: 'read_only',
    mode: 'quick',
    timeoutMs: 20_000,
    async run() {
      const context = tavern.shell.getContext();
      let chatFileName: string | null = null;
      try {
        chatFileName = tavern.chatSync.getCurrentChatFileName();
      } catch {
        // 由下方 blocked 結果提供可操作說明。
      }
      if (!context.characterName || !chatFileName) {
        return blockedForChat('請先開啟要同步的聊天。');
      }
      const exported = await tavern.chatSync.exportRawChat();
      return exported.content.trim()
        ? {
            status: 'pass',
            message: `JSONL 匯出成功，共 ${exported.messageCount} 則訊息`,
            details: { messageCount: exported.messageCount, bytes: exported.content.length }
          }
        : {
            status: 'fail',
            message: '聊天匯出結果為空',
            remediation: '請確認目前聊天已儲存且 SillyTavern 匯出端點可用。'
          };
    }
  });

  registerSelfCheck({
    id: 'autosync.events',
    label: '自動同步事件來源',
    category: 'autosync',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const diagnostics = tavern.diagnostics.eventDiagnostics();
      return diagnostics.missing.length === 0
        ? {
            status: 'pass',
            message: '事件訂閱 API 可用',
            details: {
              chatChanged: diagnostics.chatChanged,
              generationEnded: diagnostics.generationEnded
            }
          }
        : {
            status: 'fail',
            message: `缺少事件：${diagnostics.missing.join(', ')}`,
            remediation: '自動同步可能不會觸發；請更新酒館助手。',
            details: { missing: diagnostics.missing }
          };
    }
  });

  registerSelfCheck({
    id: 'autosync.queue',
    label: '待傳佇列',
    category: 'autosync',
    safety: 'read_only',
    mode: 'quick',
    async run() {
      const raw = readScriptVariable('chat_upload_queue');
      const queue = loadUploadQueue();
      if (raw !== undefined && !Array.isArray(raw)) {
        return {
          status: 'fail',
          message: '待傳佇列格式損壞',
          remediation: '請複製診斷報告後清除損壞的待傳佇列。'
        };
      }
      if (Array.isArray(raw) && raw.length !== queue.length) {
        return {
          status: 'fail',
          message: `${raw.length - queue.length} 筆待傳資料格式無效`,
          remediation: '請檢查並清理無效的待傳項目。',
          details: { stored: raw.length, valid: queue.length }
        };
      }
      const oldest = queue.map(item => item.createdAt).sort()[0] ?? null;
      return {
        status: 'pass',
        message: queue.length === 0 ? '佇列為空' : `有 ${queue.length} 筆等待補傳`,
        details: { count: queue.length, oldest }
      };
    }
  });

  registerAdvancedChatRoundtrip(tavern);
}

function registerAdvancedChatRoundtrip(tavern: SelfCheckTavernPorts): void {
  registerSelfCheck({
    id: 'advanced.chat.replace.roundtrip',
    label: '測試聊天覆寫與還原',
    category: 'advanced',
    safety: 'destructive',
    mode: 'advanced',
    timeoutMs: 45_000,
    async run() {
      if (loadSettings().autoSyncEnabled) {
        return {
          status: 'blocked',
          message: '自動同步仍在啟用中，為避免上傳測試內容而停止',
          remediation: '請先停用自動同步，並確認目前是專用測試聊天。',
          action: 'open_settings'
        };
      }
      const missing = tavern.diagnostics.chatReplaceMissing();
      if (missing.length > 0) return missingApi(missing);
      const adapter = tavern.chatSync;
      const originalMessages = adapter.getMessages();
      if (originalMessages.length === 0) return blockedForChat('目前聊天沒有訊息可供測試。');
      const original = createChatPackage({
        meta: tavern.shell.getChatMeta() ?? { chat_id: 'self_check', role_key: 'self_check' },
        deviceName: loadSettings().deviceName,
        messages: originalMessages,
        chatVariables: adapter.getChatVariables(),
        chatWorldbook: adapter.getChatWorldbook()
      });
      let restored = false;
      try {
        await tavern.diagnostics.setChatMessages([
          { message_id: originalMessages[0]?.message_id ?? 0, message: `[TavernRoamer self-check] ${Date.now()}` }
        ]);
        await adapter.replaceChat(original);
        restored = JSON.stringify(adapter.getMessages()) === JSON.stringify(originalMessages);
        return restored
          ? { status: 'pass', message: '測試聊天覆寫後已完整還原' }
          : {
              status: 'fail',
              message: '還原後訊息與原始內容不一致',
              remediation: '請勿使用聊天更新功能，並立即檢查目前測試聊天。'
            };
      } finally {
        if (!restored) await adapter.replaceChat(original);
      }
    }
  });
}

export function registerPullSelfChecks(tavern: SelfCheckTavernPorts): void {
  registerSelfCheck({
    id: 'api.chat.pull.support',
    label: '從雲端建立聊天',
    category: 'cloud_chat',
    safety: 'read_only',
    mode: 'quick',
    timeoutMs: 20_000,
    async run() {
      if (!tavern.diagnostics.hasContext()) {
        return {
          status: 'fail',
          message: '無法取得 SillyTavern context',
          remediation: '請更新酒館助手或重新整理頁面。'
        };
      }
      const missing = tavern.diagnostics.pullMissing();
      if (missing.length > 0) {
        return {
          status: 'fail',
          message: `缺少 API：${missing.join(', ')}`,
          remediation: '請更新酒館助手或確認 SillyTavern 版本相容。',
          details: { missing }
        };
      }
      const adapter = tavern.chatPull;
      const currentCharacter = adapter.getCurrentCharacterRef();
      if (adapter.listCharacterNames().length === 0 || !currentCharacter) {
        return blockedForChat('請先選擇一個角色，以檢查角色聊天清單端點。');
      }
       let files: string[];
       try {
         files = await adapter.listCharacterChatFiles(currentCharacter);
       } catch (error) {
         if (isMissingSelectionError(error)) {
           return blockedForChat('請先選擇一個角色，以檢查角色聊天清單端點。');
         }
         throw error;
       }
      return {
        status: 'pass',
        message: `必要 API 與聊天清單端點可用，目前角色有 ${files.length} 個聊天檔`,
        details: { chatFileCount: files.length }
      };
    }
  });
}

async function exportEnvironmentSnapshot(
  adapter: EnvironmentExportPort,
  kind: EnvironmentItemKind
): Promise<EnvironmentSnapshot> {
  if (kind === 'character') return adapter.exportCharacter();
  if (kind === 'world') return adapter.exportWorld();
  if (kind === 'persona') return adapter.exportPersona();
  if (kind === 'preset') return adapter.exportPreset();
  return adapter.exportRegex();
}

function validateEnvironmentSnapshot(snapshot: EnvironmentSnapshot, kind: EnvironmentItemKind): string | null {
  try {
    snapshot = parseEnvironmentSnapshot(kind, snapshot);
  } catch {
    return null;
  }
  if (snapshot.kind === 'character') return snapshot.data ? '角色卡可讀且 snapshot 格式正確' : null;
  if (snapshot.kind === 'world') {
    return snapshot.books && snapshot.bindings
      ? `世界書 bundle 可建立，共 ${Object.keys(snapshot.books).length} 本`
      : null;
  }
  if (snapshot.kind === 'persona') return snapshot.data ? '目前 Persona 可讀且 snapshot 格式正確' : null;
  if (snapshot.kind === 'preset') {
    if (!snapshot.name || snapshot.format !== 'sillytavern-openai-preset-v1' || !snapshot.data) return null;
    const data = snapshot.data as Record<string, unknown>;
    return Array.isArray(data.prompts) && Array.isArray(data.prompt_order) && data.extensions
      ? `目前預設「${snapshot.name}」原始結構完整可讀（${data.prompts.length} 個 Prompt、${data.prompt_order.length} 組排序設定）`
      : null;
  }
  return Array.isArray(snapshot.items) ? `可讀取 ${snapshot.items.length} 條全域 Regex` : null;
}

function summarizeSnapshot(snapshot: EnvironmentSnapshot): Record<string, unknown> {
  if (snapshot.kind === 'character') return { kind: snapshot.kind, characterName: snapshot.characterName };
  if (snapshot.kind === 'world') return { kind: snapshot.kind, bookCount: Object.keys(snapshot.books).length, bindings: snapshot.bindings };
  if (snapshot.kind === 'persona') return { kind: snapshot.kind, name: snapshot.name };
  if (snapshot.kind === 'preset') {
    const data = snapshot.data as Record<string, unknown> | null;
    return {
      kind: snapshot.kind,
      name: snapshot.name,
      format: snapshot.format ?? 'legacy',
      promptCount: Array.isArray(data?.prompts) ? data.prompts.length : null,
      unusedPromptCount: Array.isArray(data?.prompts_unused) ? data.prompts_unused.length : null,
      extensionKeys: data?.extensions && typeof data.extensions === 'object'
        ? Object.keys(data.extensions as Record<string, unknown>)
        : []
    };
  }
  return { kind: snapshot.kind, itemCount: snapshot.items.length };
}

function environmentLabel(kind: EnvironmentItemKind): string {
  return ({ character: '角色卡', world: '世界書', persona: 'Persona', preset: 'Preset', regex: 'Regex' })[kind];
}

function blockedForChat(remediation: string) {
  return {
    status: 'blocked' as const,
    message: '缺少目前角色或聊天',
    remediation,
    action: 'select_chat' as const
  };
}

function environmentSelectionRemediation(kind: EnvironmentItemKind): string {
  if (kind === 'character') return '請先選擇一個角色，再檢查角色卡備份。';
  if (kind === 'world') return '請先選擇角色並開啟聊天，再檢查世界書備份。';
  return `請先選擇可用的 ${environmentLabel(kind)}，再檢查備份。`;
}

function isMissingSelectionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "角色卡 'current' 不存在",
    '未打开任何聊天',
    '未開啟任何聊天',
    '無法取得目前角色',
    '無法取得目前 sillytavern 原始聊天檔資訊'
  ].some(fragment => message.includes(fragment.toLowerCase()));
}

function missingApi(names: string[]) {
  return {
    status: 'fail' as const,
    message: `缺少 API：${names.join(', ')}`,
    remediation: '請更新酒館助手或確認 SillyTavern 版本相容。',
    details: { missing: names }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

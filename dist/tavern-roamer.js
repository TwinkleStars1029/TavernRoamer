
;// ./src/auth/GoogleIdentityAuth.ts
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_SKEW_MS = 60_000;
const AUTH_POPUP_TIMEOUT_MS = 120_000;
const POPUP_CLOSED_GRACE_MS = 2_000;
class GoogleIdentityAuth {
    getClientId;
    tokenClient = null;
    tokenClientClientId = '';
    accessToken = null;
    expiresAt = 0;
    pendingRequest = null;
    lastError = null;
    oauthHost = getOAuthHostWindow();
    constructor(getClientId) {
        this.getClientId = getClientId;
    }
    getState() {
        return {
            connected: Boolean(this.accessToken && Date.now() < this.expiresAt - TOKEN_SKEW_MS),
            expiresAt: this.expiresAt || null,
            error: this.lastError
        };
    }
    async connect() {
        debugLog('connect:start', {
            host: describeWindow(this.oauthHost),
            page: describeWindow(window)
        });
        void logEnvironmentDiagnostics('connect', this.oauthHost);
        await assertOAuthPopupAllowed(this.oauthHost);
        return this.requestToken('consent');
    }
    async preload() {
        debugLog('preload:start', {
            host: describeWindow(this.oauthHost),
            page: describeWindow(window)
        });
        void logEnvironmentDiagnostics('preload', this.oauthHost);
        await loadGoogleIdentityScript(this.oauthHost);
        try {
            this.getReadyTokenClient();
        }
        catch (error) {
            debugWarn('preload:tokenClientSkipped', errorToLog(error));
        }
    }
    async getAccessToken() {
        if (this.accessToken && Date.now() < this.expiresAt - TOKEN_SKEW_MS) {
            return this.accessToken;
        }
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) {
            throw new Error('Google Drive 尚未連線或 token 已過期');
        }
        return refreshed;
    }
    async refreshAccessToken() {
        try {
            return await this.requestToken('');
        }
        catch {
            this.accessToken = null;
            this.expiresAt = 0;
            return null;
        }
    }
    async requestToken(prompt) {
        if (this.pendingRequest) {
            return this.pendingRequest;
        }
        this.pendingRequest = new Promise((resolve, reject) => {
            debugLog('requestToken:start', {
                prompt,
                host: describeWindow(this.oauthHost),
                page: describeWindow(window)
            });
            let settled = false;
            let timeoutId = null;
            let popupClosedId = null;
            const finish = (callback) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                if (popupClosedId) {
                    clearTimeout(popupClosedId);
                }
                this.pendingRequest = null;
                callback();
            };
            this.resolveTokenResponse = response => {
                debugLog('tokenResponse:received', {
                    hasAccessToken: Boolean(response.access_token),
                    expiresIn: response.expires_in ?? null,
                    error: response.error ?? null,
                    errorDescription: response.error_description ?? null
                });
                finish(() => {
                    if (response.error || !response.access_token) {
                        this.lastError = response.error_description ?? response.error ?? 'Google OAuth 授權失敗';
                        reject(new Error(this.lastError));
                        return;
                    }
                    this.accessToken = response.access_token;
                    this.expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
                    this.lastError = null;
                    resolve(response.access_token);
                });
            };
            this.resolveTokenError = error => {
                debugWarn('tokenError:received', {
                    type: error.type ?? null,
                    message: error.message ?? null,
                    raw: errorToLog(error)
                });
                if (error.type === 'popup_closed') {
                    popupClosedId = setTimeout(() => {
                        finish(() => {
                            this.lastError = tokenErrorMessage(error);
                            reject(new Error(this.lastError));
                        });
                    }, POPUP_CLOSED_GRACE_MS);
                    return;
                }
                finish(() => {
                    this.lastError = tokenErrorMessage(error);
                    reject(new Error(this.lastError));
                });
            };
            timeoutId = setTimeout(() => {
                debugWarn('requestToken:timeout', { timeoutMs: AUTH_POPUP_TIMEOUT_MS });
                this.resolveTokenError({ type: 'timeout' });
            }, AUTH_POPUP_TIMEOUT_MS);
            try {
                const readyClient = this.getReadyTokenClient();
                if (readyClient) {
                    debugLog('requestAccessToken:calling', { prompt, mode: 'ready' });
                    readyClient.requestAccessToken({ prompt });
                    return;
                }
            }
            catch (error) {
                debugWarn('requestToken:setupFailed', errorToLog(error));
                finish(() => reject(error));
                return;
            }
            void this.ensureTokenClient()
                .then(client => {
                debugLog('requestAccessToken:calling', { prompt, mode: 'after-load' });
                client.requestAccessToken({ prompt });
            })
                .catch(error => {
                debugWarn('requestToken:setupFailed', errorToLog(error));
                finish(() => reject(error));
            });
        });
        return this.pendingRequest;
    }
    resolveTokenResponse = () => undefined;
    resolveTokenError = () => undefined;
    async ensureTokenClient() {
        const readyClient = this.getReadyTokenClient();
        if (readyClient) {
            return readyClient;
        }
        const clientId = this.getClientId().trim();
        if (!clientId) {
            throw new Error('請先填入 Google OAuth Client ID');
        }
        debugLog('tokenClient:init:start', {
            clientId: maskClientId(clientId),
            host: describeWindow(this.oauthHost),
            page: describeWindow(window)
        });
        await loadGoogleIdentityScript(this.oauthHost);
        const googleApi = this.oauthHost.google?.accounts?.oauth2;
        if (!googleApi?.initTokenClient) {
            debugWarn('tokenClient:init:missingGoogleApi', {
                hasGoogle: Boolean(this.oauthHost.google),
                host: describeWindow(this.oauthHost)
            });
            throw new Error('Google Identity Services 載入失敗');
        }
        return this.createTokenClient(clientId, googleApi);
    }
    getReadyTokenClient() {
        const clientId = this.getClientId().trim();
        if (this.tokenClient && this.tokenClientClientId === clientId) {
            debugLog('tokenClient:reuse', { clientId: maskClientId(clientId) });
            return this.tokenClient;
        }
        if (!clientId) {
            throw new Error('請先填入 Google OAuth Client ID');
        }
        const googleApi = this.oauthHost.google?.accounts?.oauth2;
        if (!googleApi?.initTokenClient) {
            return null;
        }
        return this.createTokenClient(clientId, googleApi);
    }
    createTokenClient(clientId, googleApi) {
        const initTokenClient = googleApi.initTokenClient;
        if (!initTokenClient) {
            throw new Error('Google Identity Services 載入失敗');
        }
        this.tokenClient = initTokenClient({
            client_id: clientId,
            scope: DRIVE_FILE_SCOPE,
            callback: (response) => this.resolveTokenResponse(response),
            error_callback: (error) => this.resolveTokenError(error)
        });
        this.tokenClientClientId = clientId;
        debugLog('tokenClient:init:done', {
            clientId: maskClientId(clientId),
            scope: DRIVE_FILE_SCOPE
        });
        return this.tokenClient;
    }
}
function tokenErrorMessage(error) {
    if (error.type === 'popup_closed') {
        return 'Google OAuth 視窗已關閉，尚未完成授權；若 Console 顯示 COOP 為 same-origin，請將 SillyTavern server header 改成 same-origin-allow-popups 或移除';
    }
    if (error.type === 'popup_failed_to_open') {
        return 'Google OAuth 視窗無法開啟，請允許瀏覽器彈出視窗後再試';
    }
    if (error.type === 'timeout') {
        return 'Google OAuth 授權逾時，請重新按連線 Google Drive';
    }
    return error.message ?? error.type ?? 'Google OAuth 授權失敗';
}
let scriptPromise = null;
function loadGoogleIdentityScript(hostWindow) {
    if (hostWindow.google?.accounts?.oauth2) {
        debugLog('gisScript:alreadyLoaded', { host: describeWindow(hostWindow) });
        return Promise.resolve();
    }
    if (scriptPromise) {
        debugLog('gisScript:reusePending', { host: describeWindow(hostWindow) });
        return scriptPromise;
    }
    scriptPromise = new Promise((resolve, reject) => {
        const hostDocument = hostWindow.document;
        const existing = hostDocument.querySelector(`script[src="${GIS_SCRIPT_URL}"]`);
        if (existing) {
            debugLog('gisScript:existingTag', { host: describeWindow(hostWindow), readyState: existing.dataset.trReady ?? null });
            existing.addEventListener('load', () => {
                debugLog('gisScript:existingLoaded', { host: describeWindow(hostWindow) });
                resolve();
            }, { once: true });
            existing.addEventListener('error', () => {
                debugWarn('gisScript:existingError', { host: describeWindow(hostWindow) });
                reject(new Error('Google Identity Services 載入失敗'));
            }, { once: true });
            return;
        }
        const script = hostDocument.createElement('script');
        script.src = GIS_SCRIPT_URL;
        script.async = true;
        script.defer = true;
        debugLog('gisScript:append', { host: describeWindow(hostWindow), url: GIS_SCRIPT_URL });
        script.onload = () => {
            script.dataset.trReady = 'loaded';
            debugLog('gisScript:loaded', { host: describeWindow(hostWindow) });
            resolve();
        };
        script.onerror = () => {
            debugWarn('gisScript:error', { host: describeWindow(hostWindow), url: GIS_SCRIPT_URL });
            reject(new Error('Google Identity Services 載入失敗'));
        };
        hostDocument.head.append(script);
    });
    return scriptPromise;
}
function getOAuthHostWindow() {
    try {
        if (window.parent && window.parent !== window && window.parent.location.origin === 'http://127.0.0.1:8000') {
            debugLog('oauthHost:selectedParent', { origin: window.parent.location.origin });
            return window.parent;
        }
        if (window.parent && window.parent !== window && window.parent.location.origin === 'http://localhost:8000') {
            debugLog('oauthHost:selectedParent', { origin: window.parent.location.origin });
            return window.parent;
        }
        if (window.top && window.top !== window && window.top.location.origin.startsWith('http')) {
            debugLog('oauthHost:selectedTop', { origin: window.top.location.origin });
            return window.top;
        }
    }
    catch {
        debugWarn('oauthHost:crossOriginFallback', { page: describeWindow(window) });
        return window;
    }
    debugLog('oauthHost:selectedSelf', { origin: window.location.origin });
    return window;
}
function debugLog(event, details) {
    console.info(formatDebugMessage(event, details));
}
function debugWarn(event, details) {
    console.warn(formatDebugMessage(event, details));
}
function formatDebugMessage(event, details) {
    const detailsText = stringifyDebugDetails(details);
    return `[TavernRoamer OAuth] ${event}${detailsText ? ` ${detailsText}` : ''}`;
}
function stringifyDebugDetails(details) {
    if (details === undefined || details === null || details === '') {
        return '';
    }
    if (typeof details === 'string') {
        return details;
    }
    try {
        return JSON.stringify(details);
    }
    catch {
        return String(details);
    }
}
function describeWindow(targetWindow) {
    try {
        return {
            origin: targetWindow.location.origin,
            href: targetWindow.location.href,
            isSelf: targetWindow === window,
            isParent: targetWindow === window.parent,
            isTop: targetWindow === window.top,
            readyState: targetWindow.document.readyState
        };
    }
    catch (error) {
        return {
            inaccessible: true,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
function maskClientId(clientId) {
    if (clientId.length <= 18) {
        return clientId;
    }
    return `${clientId.slice(0, 12)}...${clientId.slice(-18)}`;
}
function errorToLog(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    if (error && typeof error === 'object') {
        return Object.fromEntries(Object.entries(error).map(([key, value]) => [key, typeof value === 'function' ? '[function]' : value]));
    }
    return { value: String(error) };
}
async function logEnvironmentDiagnostics(phase, hostWindow) {
    debugLog(`env:${phase}:snapshot`, {
        page: getWindowDiagnostics(window),
        host: getWindowDiagnostics(hostWindow),
        currentFrame: getFrameDiagnostics(window)
    });
    try {
        const response = await fetchHostHead(hostWindow);
        debugLog(`env:${phase}:headers`, {
            url: hostWindow.location.href,
            status: response.status,
            coop: response.headers.get('cross-origin-opener-policy'),
            coopReportOnly: response.headers.get('cross-origin-opener-policy-report-only'),
            coep: response.headers.get('cross-origin-embedder-policy'),
            csp: response.headers.get('content-security-policy')
        });
    }
    catch (error) {
        debugWarn(`env:${phase}:headersFailed`, errorToLog(error));
    }
}
async function assertOAuthPopupAllowed(hostWindow) {
    try {
        const response = await fetchHostHead(hostWindow);
        const coop = response.headers.get('cross-origin-opener-policy');
        const normalizedCoop = coop?.toLowerCase().trim() ?? null;
        debugLog('env:oauthCompatibility', {
            status: response.status,
            coop,
            coep: response.headers.get('cross-origin-embedder-policy')
        });
        if (normalizedCoop === 'same-origin') {
            throw new Error('SillyTavern 目前送出 Cross-Origin-Opener-Policy: same-origin，Google OAuth popup 無法回傳授權結果。請將 server header 改成 same-origin-allow-popups 或移除該 header，重啟 SillyTavern 後再試。');
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('Cross-Origin-Opener-Policy: same-origin')) {
            throw error;
        }
        debugWarn('env:oauthCompatibilitySkipped', errorToLog(error));
    }
}
function fetchHostHead(hostWindow) {
    return hostWindow.fetch(hostWindow.location.href, {
        method: 'HEAD',
        credentials: 'same-origin',
        cache: 'no-store'
    });
}
function getWindowDiagnostics(targetWindow) {
    try {
        return {
            ...describeWindow(targetWindow),
            isSecureContext: targetWindow.isSecureContext,
            crossOriginIsolated: targetWindow.crossOriginIsolated,
            hasOpener: Boolean(targetWindow.opener),
            cookieEnabled: targetWindow.navigator.cookieEnabled,
            userAgent: targetWindow.navigator.userAgent
        };
    }
    catch (error) {
        return {
            inaccessible: true,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
function getFrameDiagnostics(targetWindow) {
    try {
        const frameElement = targetWindow.frameElement;
        return {
            hasFrameElement: Boolean(frameElement),
            sandbox: frameElement?.getAttribute('sandbox') ?? null,
            allow: frameElement?.getAttribute('allow') ?? null,
            src: frameElement?.getAttribute('src') ?? null
        };
    }
    catch (error) {
        return {
            inaccessible: true,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}


;// ./src/types.ts
const SCRIPT_ID = 'tavern-roamer';
const SETTINGS_KEY = 'tavern_roamer_settings';
const CHAT_META_KEY = '_drive_sync';

;// ./src/settings.ts

const defaultSettings = {
    deviceName: defaultDeviceName(),
    googleClientId: '',
    autoSyncEnabled: true,
    autoSyncEveryN: 1,
    chatRetention: {
        mode: 'keep_latest_n',
        latestN: 10
    }
};
function normalizeSettings(value) {
    const candidate = isRecord(value) ? value : {};
    const chatRetention = isRecord(candidate.chatRetention) ? candidate.chatRetention : {};
    return {
        deviceName: readString(candidate.deviceName, defaultSettings.deviceName),
        googleClientId: readString(candidate.googleClientId, ''),
        autoSyncEnabled: typeof candidate.autoSyncEnabled === 'boolean' ? candidate.autoSyncEnabled : true,
        autoSyncEveryN: readPositiveInteger(candidate.autoSyncEveryN, defaultSettings.autoSyncEveryN),
        chatRetention: {
            mode: chatRetention.mode === 'keep_all' ? 'keep_all' : 'keep_latest_n',
            latestN: readPositiveInteger(chatRetention.latestN, defaultSettings.chatRetention.latestN)
        }
    };
}
function loadSettings() {
    return normalizeSettings(readScriptVariable(SETTINGS_KEY));
}
function saveSettings(settings) {
    const normalized = normalizeSettings(settings);
    writeScriptVariable(SETTINGS_KEY, normalized);
    return normalized;
}
function readScriptVariable(key) {
    const globals = globalThis;
    if (typeof globals.getVariables === 'function') {
        const variables = globals.getVariables({
            type: 'script',
            script_id: typeof globals.getScriptId === 'function' ? globals.getScriptId() : SCRIPT_ID
        });
        return variables?.[key];
    }
    try {
        const raw = globalThis.localStorage?.getItem(`${SCRIPT_ID}:${key}`);
        return raw ? JSON.parse(raw) : undefined;
    }
    catch {
        return undefined;
    }
}
function writeScriptVariable(key, value) {
    const globals = globalThis;
    if (typeof globals.insertOrAssignVariables === 'function') {
        globals.insertOrAssignVariables({ [key]: value }, {
            type: 'script',
            script_id: typeof globals.getScriptId === 'function' ? globals.getScriptId() : SCRIPT_ID
        });
        return;
    }
    globalThis.localStorage?.setItem(`${SCRIPT_ID}:${key}`, JSON.stringify(value));
}
function defaultDeviceName() {
    const host = globalThis.location?.hostname;
    if (host) {
        return host === '127.0.0.1' || host === 'localhost' ? 'A電腦' : host;
    }
    return 'A電腦';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function readString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value : fallback;
}
function readPositiveInteger(value, fallback) {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

;// ./src/chat/AutoSyncController.ts

class AutoSyncController {
    options;
    messageCount = 0;
    timer = null;
    setTimeoutImpl;
    clearTimeoutImpl;
    debounceMs;
    constructor(options) {
        this.options = options;
        this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
        this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
        this.debounceMs = options.debounceMs ?? 10_000;
    }
    handleMessageCompleted() {
        const settings = loadSettings();
        if (!settings.autoSyncEnabled) {
            return;
        }
        this.messageCount += 1;
        if (this.messageCount < settings.autoSyncEveryN) {
            return;
        }
        this.messageCount = 0;
        this.schedule();
    }
    stop() {
        if (this.timer) {
            this.clearTimeoutImpl(this.timer);
            this.timer = null;
        }
    }
    schedule() {
        if (this.timer) {
            this.clearTimeoutImpl(this.timer);
        }
        this.timer = this.setTimeoutImpl(() => {
            this.timer = null;
            void this.options.upload();
        }, this.debounceMs);
    }
}

;// ./src/drive/version.ts
const VERSION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)__(.+)\.(json|jsonl)$/;
function createUtcTimestamp(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}
function parseUtcTimestamp(timestamp) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(timestamp)) {
        return null;
    }
    const iso = timestamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1T$2:$3:$4Z');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}
function buildVersionFilename(deviceName, date = new Date(), extension = 'json') {
    return `${createUtcTimestamp(date)}__${sanitizeVersionDevice(deviceName)}.${extension}`;
}
function parseVersionFilename(filename) {
    const match = VERSION_FILENAME_PATTERN.exec(filename);
    if (!match) {
        return null;
    }
    const uploadedAtUtc = match[1] ?? '';
    const device = match[2] ?? '';
    const uploadedAt = parseUtcTimestamp(uploadedAtUtc);
    if (!uploadedAt) {
        return null;
    }
    return { uploadedAt, uploadedAtUtc, device };
}
function itemToVersion(item) {
    const parsed = parseVersionFilename(item.name);
    if (!parsed) {
        return null;
    }
    return {
        ...parsed,
        fileId: item.id,
        filename: item.name
    };
}
function sortVersions(versions) {
    return [...versions].sort((left, right) => left.filename.localeCompare(right.filename));
}
function formatLocalTime(date, locale = defaultLocale(), timeZone) {
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    if (timeZone) {
        options.timeZone = timeZone;
    }
    return new Intl.DateTimeFormat(locale, options).format(date);
}
/**
 * 將 last_synced_version 檔名（UTC 時間戳）解析為本地時區字串。
 * 純函式：無效 / 缺值檔名回退 fallback（預設「—」），可指定 locale / timeZone 以利測試。
 */
function formatLastSyncedLabel(filename, options = {}) {
    const fallback = options.fallback ?? '—';
    if (typeof filename !== 'string' || filename.length === 0) {
        return fallback;
    }
    const parsed = parseVersionFilename(filename);
    if (!parsed) {
        return fallback;
    }
    return formatLocalTime(parsed.uploadedAt, options.locale ?? defaultLocale(), options.timeZone);
}
function defaultLocale() {
    try {
        return globalThis.navigator?.language ?? 'en-US';
    }
    catch {
        return 'en-US';
    }
}
function sanitizeVersionDevice(deviceName) {
    return [...deviceName]
        .map(char => (isUnsafeFilenameChar(char) ? '_' : char))
        .join('')
        .trim() || 'unknown-device';
}
function isUnsafeFilenameChar(char) {
    return '\\/:*?"<>|#'.includes(char) || char.charCodeAt(0) < 32;
}

;// ./src/roleKey.ts
const DRIVE_CONFUSING_CHARS = '\\/:*?"<>|#';
function sanitizeRoleKey(value, fallback = '未命名角色') {
    const normalized = value
        .normalize('NFKC')
        .split('')
        .map(char => (isUnsafeRoleKeyChar(char) ? ' ' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized || fallback;
}
function isUnsafeRoleKeyChar(char) {
    return DRIVE_CONFUSING_CHARS.includes(char) || char.charCodeAt(0) < 32;
}

;// ./src/chat/meta.ts


function ensureSyncMeta(store, deviceName) {
    const variables = store.getChatVariables();
    const existing = variables[CHAT_META_KEY];
    const derivedChatId = deriveChatId(store.getCurrentChatFileName());
    if (isChatSyncMeta(existing)) {
        if (derivedChatId && existing.chat_id !== derivedChatId) {
            const rebound = {
                ...existing,
                chat_id: derivedChatId,
                device_name: existing.device_name ?? deviceName
            };
            store.writeChatVariables({ [CHAT_META_KEY]: rebound });
            return rebound;
        }
        return existing;
    }
    const characterName = store.getCurrentCharacterName() ?? '未命名角色';
    const meta = {
        chat_id: derivedChatId ?? buildFallbackChatId(store.getCurrentChatFileName()),
        role_key: sanitizeRoleKey(characterName),
        device_name: deviceName
    };
    store.writeChatVariables({ [CHAT_META_KEY]: meta });
    return meta;
}
function updateLastSyncedVersion(store, meta, filename, messageCount) {
    const next = {
        ...meta,
        last_synced_version: filename,
        last_synced_message_count: messageCount
    };
    store.writeChatVariables({ [CHAT_META_KEY]: next });
    return next;
}
function isChatSyncMeta(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const meta = value;
    return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string';
}
function deriveChatId(fileName) {
    if (!fileName) {
        return null;
    }
    const normalized = fileName.trim();
    const prefixedMatch = normalized.match(/ - (\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms)(?:\.[^.]+)?$/);
    if (prefixedMatch?.[1]) {
        return prefixedMatch[1];
    }
    const bareMatch = normalized.match(/^(\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms)(?:\.[^.]+)?$/);
    return bareMatch?.[1] ?? null;
}
function buildFallbackChatId(fileName) {
    const stem = fileName?.trim().replace(/\.[^.]+$/, '');
    if (stem) {
        return stem;
    }
    return `chat_${Date.now()}`;
}

;// ./src/chat/package.ts

const CHAT_PACKAGE_FORMAT_VERSION = 1;
function createChatPackage(input) {
    const metadata = {
        chat_id: input.meta.chat_id,
        role_key: input.meta.role_key,
        device: input.deviceName,
        message_count: input.messages.length,
        packed_at: (input.packedAt ?? new Date()).toISOString()
    };
    if (input.meta.last_synced_version) {
        metadata.last_synced_version = input.meta.last_synced_version;
    }
    return {
        format_version: CHAT_PACKAGE_FORMAT_VERSION,
        metadata,
        chat_variables: {
            ...input.chatVariables,
            [CHAT_META_KEY]: input.meta
        },
        chat_worldbook: input.chatWorldbook,
        messages: input.messages.map(message => ({ ...message }))
    };
}
function unpackChatPackage(value) {
    const parsed = typeof value === 'string' ? safeParseJson(value) : value;
    if (!package_isRecord(parsed)) {
        throw new Error('聊天包不是有效 JSON 物件');
    }
    if (parsed.format_version !== CHAT_PACKAGE_FORMAT_VERSION) {
        throw new Error(`不支援的聊天包版本：${String(parsed.format_version)}`);
    }
    if (!package_isRecord(parsed.metadata)) {
        throw new Error('聊天包缺少 metadata');
    }
    const metadata = parsed.metadata;
    if (typeof metadata.chat_id !== 'string' || typeof metadata.role_key !== 'string') {
        throw new Error('聊天包 metadata 缺少 chat_id 或 role_key');
    }
    if (!Array.isArray(parsed.messages)) {
        throw new Error('聊天包 messages 不是陣列');
    }
    if (!parsed.messages.every(message => package_isRecord(message) && Number.isInteger(message.message_id))) {
        throw new Error('聊天包 messages 含有無效樓層');
    }
    return parsed;
}
function safeParseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        throw new Error('聊天包 JSON 損壞，無法解析');
    }
}
function package_isRecord(value) {
    return typeof value === 'object' && value !== null;
}

;// ./src/chat/queue.ts

const QUEUE_KEY = 'chat_upload_queue';
function loadUploadQueue() {
    const value = readScriptVariable(QUEUE_KEY);
    return Array.isArray(value) ? value.filter(isQueuedUpload) : [];
}
function saveUploadQueue(queue) {
    writeScriptVariable(QUEUE_KEY, queue);
}
function enqueueUpload(upload) {
    const queue = loadUploadQueue();
    const next = {
        ...upload,
        id: globalThis.crypto?.randomUUID?.() ?? `queue_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toISOString(),
        attempts: 0
    };
    const updated = [...queue, next];
    saveUploadQueue(updated);
    return updated;
}
function removeQueuedUpload(id) {
    const updated = loadUploadQueue().filter(item => item.id !== id);
    saveUploadQueue(updated);
    return updated;
}
function incrementQueuedUpload(id) {
    const updated = loadUploadQueue().map(item => (item.id === id ? { ...item, attempts: item.attempts + 1 } : item));
    saveUploadQueue(updated);
    return updated;
}
function isQueuedUpload(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const item = value;
    return (typeof item.id === 'string' &&
        Array.isArray(item.path) &&
        typeof item.filename === 'string' &&
        (typeof item.package === 'object' || typeof item.package === 'string') &&
        typeof item.createdAt === 'string' &&
        typeof item.attempts === 'number');
}

;// ./src/chat/ChatSyncService.ts





const RAW_CHAT_MIME = 'application/x-ndjson; charset=UTF-8';
class ChatSyncService {
    tavern;
    drive;
    constructor(tavern, drive) {
        this.tavern = tavern;
        this.drive = drive;
    }
    ensureSyncMeta() {
        return ensureSyncMeta(this.tavern, loadSettings().deviceName);
    }
    packChat(meta = this.ensureSyncMeta()) {
        const settings = loadSettings();
        return createChatPackage({
            meta,
            deviceName: settings.deviceName,
            messages: this.tavern.getMessages(),
            chatVariables: this.tavern.getChatVariables(),
            chatWorldbook: this.tavern.getChatWorldbook()
        });
    }
    async uploadCurrentChat(options = {}) {
        const meta = this.ensureSyncMeta();
        const rawChat = await this.tavern.exportRawChat();
        const filename = buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl');
        const path = driveChatPath(meta);
        try {
            const folderId = await this.drive.ensureFolderPath(path);
            await this.drive.uploadText(folderId, filename, rawChat.content, RAW_CHAT_MIME);
            await this.cleanupOldVersions(folderId);
            updateLastSyncedVersion(this.tavern, meta, filename, rawChat.messageCount);
            return { meta: { ...meta, last_synced_version: filename }, filename, queued: false };
        }
        catch (error) {
            if (options.queueOnFail) {
                enqueueUpload({ path, filename, package: rawChat.content, mimeType: RAW_CHAT_MIME });
                return { meta, filename, queued: true };
            }
            throw error;
        }
    }
    async flushQueue() {
        let uploaded = 0;
        for (const item of loadUploadQueue()) {
            try {
                const folderId = await this.drive.ensureFolderPath(item.path);
                if (typeof item.package === 'string') {
                    await this.drive.uploadText(folderId, item.filename, item.package, item.mimeType);
                }
                else {
                    await this.drive.uploadJson(folderId, item.filename, item.package);
                }
                removeQueuedUpload(item.id);
                uploaded += 1;
            }
            catch {
                incrementQueuedUpload(item.id);
            }
        }
        return { uploaded, remaining: loadUploadQueue().length };
    }
    async downloadLatestAndReplace() {
        const meta = this.ensureSyncMeta();
        const path = driveChatPath(meta);
        const versions = await this.drive.listVersions(path);
        const latest = versions.at(-1);
        if (!latest) {
            throw new Error('雲端沒有可下載的聊天版本');
        }
        await this.uploadPreRestore(meta);
        if (latest.filename.endsWith('.jsonl')) {
            const content = await this.drive.downloadText(latest.fileId);
            await this.tavern.replaceRawChat(content);
            updateLastSyncedVersion(this.tavern, meta, latest.filename, countJsonlMessages(content));
            return latest.filename;
        }
        const downloaded = await this.drive.downloadJson(latest.fileId);
        const chatPackage = unpackChatPackage(downloaded);
        await this.tavern.replaceChat(chatPackage);
        updateLastSyncedVersion(this.tavern, meta, latest.filename, chatPackage.messages.length);
        return latest.filename;
    }
    async getLatestRemoteFilename(meta = this.ensureSyncMeta()) {
        const versions = await this.drive.listVersions(driveChatPath(meta));
        return versions.at(-1)?.filename ?? null;
    }
    async uploadPreRestore(meta) {
        const rawChat = await this.tavern.exportRawChat();
        const folderId = await this.drive.ensureFolderPath([
            'SillyTavernSync',
            meta.role_key,
            meta.chat_id,
            '_pre_restore',
            new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
        ]);
        await this.drive.uploadText(folderId, buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl'), rawChat.content, RAW_CHAT_MIME);
    }
    async cleanupOldVersions(folderId) {
        const settings = loadSettings();
        if (settings.chatRetention.mode !== 'keep_latest_n') {
            return;
        }
        const versions = await this.drive.listVersions(folderId);
        const stale = versions.slice(0, Math.max(0, versions.length - settings.chatRetention.latestN));
        await Promise.all(stale.map(version => this.drive.deleteFile(version.fileId)));
    }
}
function driveChatPath(meta) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, 'chat'];
}
function countJsonlMessages(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length === 0) {
        return 0;
    }
    try {
        const header = JSON.parse(lines[0] ?? '{}');
        if (header.user_name !== undefined || header.name !== undefined || header.chat_metadata !== undefined) {
            return Math.max(0, lines.length - 1);
        }
    }
    catch {
        return lines.length;
    }
    return lines.length;
}

;// ./src/chat/status.ts
function computeSyncStatus(input) {
    if (!input.connected) {
        return 'not_connected';
    }
    if (!input.meta?.last_synced_version) {
        return input.localMessageCount > 0 ? 'local_dirty' : 'unknown';
    }
    if (input.remoteLatestFilename && input.remoteLatestFilename > input.meta.last_synced_version) {
        return 'newer_remote';
    }
    if ((input.meta.last_synced_message_count ?? 0) < input.localMessageCount) {
        return 'local_dirty';
    }
    return 'synced';
}

;// ./src/drive/DriveClient.ts
class DriveError extends Error {
    status;
    code;
    constructor(message, status, code = 'drive_error') {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'DriveError';
    }
}

;// ./src/drive/retry.ts

async function withDriveRetry(operation, options = {}) {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 400;
    const sleep = options.sleep ?? defaultSleep;
    let refreshedAfter401 = false;
    for (let attempt = 0;; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            if (!(error instanceof DriveError)) {
                throw error;
            }
            if (error.status === 401 && options.onUnauthorized && !refreshedAfter401) {
                refreshedAfter401 = true;
                const refreshed = await options.onUnauthorized();
                if (refreshed) {
                    continue;
                }
            }
            if (!isRetryable(error.status) || attempt >= maxRetries) {
                throw error;
            }
            await sleep(baseDelayMs * 2 ** attempt);
        }
    }
}
function isRetryable(status) {
    return status === 429 || status >= 500;
}
function defaultSleep(ms) {
    return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

;// ./src/drive/GoogleDriveClient.ts


const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;
class GoogleDriveClient {
    options;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    }
    async findFoldersByName(name, parentId) {
        const query = [
            `name = '${escapeDriveQueryString(name)}'`,
            `mimeType = '${FOLDER_MIME}'`,
            'trashed = false',
            parentId ? `'${escapeDriveQueryString(parentId)}' in parents` : "'root' in parents"
        ].join(' and ');
        const files = await this.listRaw(query);
        return files.map(toDriveItem);
    }
    async ensureFolder(name, parentId) {
        const existing = await this.findFoldersByName(name, parentId);
        if (existing[0]) {
            return existing[0];
        }
        const metadata = {
            name,
            mimeType: FOLDER_MIME,
            parents: parentId ? [parentId] : undefined
        };
        const created = await this.requestJson(`${DRIVE_API}/files?fields=id,name,mimeType,parents,createdTime,modifiedTime`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(metadata)
        });
        return toDriveItem(created);
    }
    async uploadJson(parentId, name, data) {
        const content = JSON.stringify(data, null, 2);
        return this.uploadText(parentId, name, content, 'application/json');
    }
    async uploadText(parentId, name, content, mimeType = 'text/plain; charset=UTF-8') {
        const size = new TextEncoder().encode(content).byteLength;
        if (size > RESUMABLE_THRESHOLD_BYTES) {
            return this.uploadResumable(parentId, name, content, mimeType);
        }
        return this.uploadMultipart(parentId, name, content, mimeType);
    }
    async listFiles(parentId) {
        const query = [
            `'${escapeDriveQueryString(parentId)}' in parents`,
            `mimeType != '${FOLDER_MIME}'`,
            'trashed = false'
        ].join(' and ');
        const files = await this.listRaw(query);
        return files.map(toDriveItem).sort((left, right) => left.name.localeCompare(right.name));
    }
    async downloadJson(fileId) {
        return this.requestJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    }
    async downloadText(fileId) {
        const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
        return response.text();
    }
    async deleteFile(fileId) {
        await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    }
    async getAccountEmail() {
        try {
            const about = await this.requestJson(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`);
            return about.user?.emailAddress ?? null;
        }
        catch {
            return null;
        }
    }
    async listRaw(query) {
        const params = new URLSearchParams({
            q: query,
            spaces: 'drive',
            fields: 'files(id,name,mimeType,parents,createdTime,modifiedTime,size)',
            pageSize: '1000'
        });
        const result = await this.requestJson(`${DRIVE_API}/files?${params.toString()}`);
        return result.files ?? [];
    }
    async uploadMultipart(parentId, name, content, mimeType) {
        const boundary = `tavern_roamer_${Date.now().toString(36)}`;
        const metadata = {
            name,
            parents: [parentId],
            mimeType
        };
        const body = [
            `--${boundary}`,
            'Content-Type: application/json; charset=UTF-8',
            '',
            JSON.stringify(metadata),
            `--${boundary}`,
            `Content-Type: ${mimeType}`,
            '',
            content,
            `--${boundary}--`
        ].join('\r\n');
        const file = await this.requestJson(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,parents,createdTime,modifiedTime,size`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        return withUploadKind(toDriveItem(file), 'multipart');
    }
    async uploadResumable(parentId, name, content, mimeType) {
        const bytes = new TextEncoder().encode(content);
        const session = await this.request(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,parents,createdTime,modifiedTime,size`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': String(bytes.byteLength)
            },
            body: JSON.stringify({ name, parents: [parentId], mimeType })
        });
        const uploadUrl = session.headers.get('Location');
        if (!uploadUrl) {
            throw new DriveError('Drive resumable upload did not return a session URL', 502, 'missing_upload_location');
        }
        const uploaded = await this.requestJson(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': mimeType,
                'Content-Length': String(bytes.byteLength)
            },
            body: content
        });
        return withUploadKind(toDriveItem(uploaded), 'resumable');
    }
    async requestJson(url, init = {}) {
        const response = await this.request(url, init);
        if (response.status === 204) {
            return undefined;
        }
        return (await response.json());
    }
    async request(url, init = {}) {
        return withDriveRetry(async () => {
            const token = await this.options.tokenProvider.getAccessToken();
            const headers = new Headers(init.headers);
            headers.set('Authorization', `Bearer ${token}`);
            const response = await this.fetchImpl(url, { ...init, headers });
            if (!response.ok) {
                throw new DriveError(await errorMessage(response), response.status, 'http_error');
            }
            return response;
        }, {
            ...this.options.retry,
            onUnauthorized: async () => Boolean(await this.options.tokenProvider.refreshAccessToken())
        });
    }
}
function toDriveItem(file) {
    const item = {
        id: file.id,
        name: file.name,
        parentId: file.parents?.[0] ?? null,
        type: file.mimeType === FOLDER_MIME ? 'folder' : 'file',
        createdAt: file.createdTime ?? new Date().toISOString(),
        updatedAt: file.modifiedTime ?? file.createdTime ?? new Date().toISOString()
    };
    if (file.mimeType) {
        item.mimeType = file.mimeType;
    }
    return item;
}
function withUploadKind(item, uploadKind) {
    return { ...item, uploadKind };
}
function escapeDriveQueryString(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
async function errorMessage(response) {
    try {
        const body = (await response.json());
        return body.error?.message ?? `Drive API request failed with ${response.status}`;
    }
    catch {
        return `Drive API request failed with ${response.status}`;
    }
}

;// ./src/drive/DriveService.ts



const FOLDER_CACHE_KEY = 'drive_folder_cache';
class DriveService {
    client;
    constructor(client) {
        this.client = client;
    }
    async ensureFolderPath(path) {
        const normalized = normalizePath(path);
        const cacheKey = cacheKeyFor(normalized);
        const cache = loadFolderCache();
        const cached = cache[cacheKey];
        if (cached && (await this.folderExists(cached))) {
            return cached;
        }
        let parentId = null;
        const resolvedPath = [];
        for (const segment of normalized) {
            resolvedPath.push(segment);
            const segmentKey = cacheKeyFor(resolvedPath);
            const cachedSegmentId = cache[segmentKey];
            if (cachedSegmentId && (await this.folderExists(cachedSegmentId))) {
                parentId = cachedSegmentId;
                continue;
            }
            const folder = await this.ensureChildFolder(segment, parentId);
            parentId = folder.id;
            cache[segmentKey] = parentId;
            saveFolderCacheEntry(segmentKey, parentId);
        }
        if (!parentId) {
            throw new DriveError('Cannot resolve empty Drive path', 400, 'empty_path');
        }
        saveFolderCacheEntry(cacheKey, parentId);
        return parentId;
    }
    async resolveFolderPathAll(path) {
        const normalized = normalizePath(path);
        let parentIds = [null];
        for (const segment of normalized) {
            const next = await Promise.all(parentIds.map(parentId => this.client.findFoldersByName(segment, parentId)));
            parentIds = next.flat().map(folder => folder.id);
            if (parentIds.length === 0) {
                return [];
            }
        }
        return parentIds.filter((id) => typeof id === 'string');
    }
    async listVersions(folderOrPath) {
        const folderIds = Array.isArray(folderOrPath) ? await this.resolveFolderPathAll(folderOrPath) : [folderOrPath];
        const files = (await Promise.all(folderIds.map(folderId => this.client.listFiles(folderId)))).flat();
        const versions = files.map(itemToVersion).filter((version) => Boolean(version));
        return sortVersions(dedupeVersions(versions));
    }
    async uploadJson(folderId, filename, content) {
        return this.client.uploadJson(folderId, filename, content);
    }
    async uploadText(folderId, filename, content, mimeType) {
        return this.client.uploadText(folderId, filename, content, mimeType);
    }
    async downloadJson(fileId) {
        return this.client.downloadJson(fileId);
    }
    async downloadText(fileId) {
        return this.client.downloadText(fileId);
    }
    async deleteFile(fileId) {
        return this.client.deleteFile(fileId);
    }
    clearFolderCache() {
        writeScriptVariable(FOLDER_CACHE_KEY, {});
    }
    async folderExists(folderId) {
        try {
            await this.client.listFiles(folderId);
            return true;
        }
        catch (error) {
            if (error instanceof DriveError && error.status === 404) {
                removeFolderCacheEntry(folderId);
                return false;
            }
            throw error;
        }
    }
    async ensureChildFolder(name, parentId) {
        const existing = await this.client.findFoldersByName(name, parentId);
        if (existing[0]) {
            return existing[0];
        }
        const created = await this.client.ensureFolder(name, parentId);
        const resolved = await this.client.findFoldersByName(name, parentId);
        return resolved.find(folder => folder.id === created.id) ?? resolved[0] ?? created;
    }
}
function normalizePath(path) {
    const normalized = path.map(segment => segment.trim()).filter(Boolean);
    if (normalized.length === 0) {
        throw new DriveError('Drive path cannot be empty', 400, 'empty_path');
    }
    return normalized;
}
function cacheKeyFor(path) {
    return path.join('/');
}
function loadFolderCache() {
    const value = readScriptVariable(FOLDER_CACHE_KEY);
    if (typeof value !== 'object' || value === null) {
        return {};
    }
    return { ...value };
}
function saveFolderCacheEntry(key, folderId) {
    writeScriptVariable(FOLDER_CACHE_KEY, { ...loadFolderCache(), [key]: folderId });
}
function removeFolderCacheEntry(folderId) {
    const cache = loadFolderCache();
    for (const [key, value] of Object.entries(cache)) {
        if (value === folderId) {
            delete cache[key];
        }
    }
    writeScriptVariable(FOLDER_CACHE_KEY, cache);
}
function dedupeVersions(versions) {
    const seen = new Map();
    for (const version of versions) {
        seen.set(version.fileId, version);
    }
    return [...seen.values()];
}

;// ./src/environment/types.ts
const ENVIRONMENT_ITEM_KINDS = ['character', 'world', 'persona', 'preset', 'regex'];

;// ./src/environment/EnvironmentBackupService.ts




class EnvironmentBackupService {
    tavern;
    drive;
    constructor(tavern, drive) {
        this.tavern = tavern;
        this.drive = drive;
    }
    async backupAll(options = {}) {
        return this.backupItems(ENVIRONMENT_ITEM_KINDS, options);
    }
    async backupItems(kinds, options = {}) {
        const { meta = this.ensureSyncMeta(), onProgress } = options;
        // 同一批備份共用一個 UTC 時間戳（手冊第九章：時間戳同一批一致）
        const filename = buildVersionFilename(loadSettings().deviceName);
        const results = [];
        for (const kind of kinds) {
            let step = 'export';
            try {
                onProgress?.({ kind, step: 'export', state: 'start' });
                const snapshot = await this.exportSnapshot(kind);
                onProgress?.({ kind, step: 'export', state: 'done' });
                step = 'upload';
                onProgress?.({ kind, step: 'upload', state: 'start' });
                const folderId = await this.drive.ensureFolderPath(environmentItemPath(meta, kind));
                await this.drive.uploadJson(folderId, filename, snapshot);
                await this.cleanupOldVersions(folderId);
                onProgress?.({ kind, step: 'upload', state: 'done', filename });
                results.push({ kind, status: 'done', filename });
            }
            catch (error) {
                // 單項失敗：記錄後繼續下一項（取代原本 throw 全斷）
                const message = error instanceof Error ? error.message : String(error);
                onProgress?.({ kind, step, state: 'error', error: message });
                results.push({ kind, status: 'error', error: message });
            }
        }
        return results;
    }
    async listItemVersions(kind, meta = this.ensureSyncMeta()) {
        return this.drive.listVersions(environmentItemPath(meta, kind));
    }
    async downloadItem(kind, fileId) {
        const downloaded = await this.drive.downloadJson(fileId);
        return assertSnapshotKind(kind, downloaded);
    }
    ensureSyncMeta() {
        return ensureSyncMeta(this.tavern, loadSettings().deviceName);
    }
    async exportSnapshot(kind) {
        if (kind === 'character') {
            return this.tavern.exportCharacter();
        }
        if (kind === 'world') {
            return this.tavern.exportWorld();
        }
        if (kind === 'persona') {
            return this.tavern.exportPersona();
        }
        if (kind === 'preset') {
            return this.tavern.exportPreset();
        }
        return this.tavern.exportRegex();
    }
    async cleanupOldVersions(folderId) {
        const settings = loadSettings();
        if (settings.chatRetention.mode !== 'keep_latest_n') {
            return;
        }
        const versions = await this.drive.listVersions(folderId);
        const stale = versions.slice(0, Math.max(0, versions.length - settings.chatRetention.latestN));
        await Promise.all(stale.map(version => this.drive.deleteFile(version.fileId)));
    }
}
function environmentItemPath(meta, kind) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}
function assertSnapshotKind(kind, value) {
    if (!value || typeof value !== 'object') {
        throw new Error(`Environment snapshot for ${kind} is not a JSON object`);
    }
    const snapshot = value;
    if (snapshot.kind !== kind || typeof snapshot.exportedAt !== 'string') {
        throw new Error(`Environment snapshot for ${kind} is invalid`);
    }
    return snapshot;
}

;// ./src/environment/EnvironmentRestoreService.ts




class EnvironmentRestoreService {
    tavern;
    drive;
    constructor(tavern, drive) {
        this.tavern = tavern;
        this.drive = drive;
    }
    ensureSyncMeta() {
        return ensureSyncMeta(this.tavern, loadSettings().deviceName);
    }
    async restoreLatest(kinds, options = {}) {
        const { meta = this.ensureSyncMeta(), onProgress } = options;
        const orderedKinds = ENVIRONMENT_ITEM_KINDS.filter(kind => kinds.includes(kind));
        const resolved = await Promise.all(orderedKinds.map(async (kind) => {
            const versions = await this.drive.listVersions(EnvironmentRestoreService_environmentItemPath(meta, kind));
            const latest = versions.at(-1) ?? null;
            return { kind, latest };
        }));
        if (!resolved.some(entry => entry.latest !== null)) {
            throw new Error('雲端找不到可還原的環境備份');
        }
        // 同一批覆蓋前備份共用一個時間戳（資料夾層與檔名層皆一致）
        const restorePointTimestamp = createUtcTimestamp();
        const restorePointPath = ['SillyTavernSync', meta.role_key, meta.chat_id, '_pre_restore', restorePointTimestamp];
        const restorePointFilename = buildVersionFilename(loadSettings().deviceName);
        const items = [];
        for (const entry of resolved) {
            // 雲端沒版本 → 略過，不備份也不套用
            if (entry.latest === null) {
                items.push({ kind: entry.kind, status: 'skipped' });
                continue;
            }
            // 覆蓋前備份：只備份即將被覆蓋的項目；失敗則中止該項、不 download 不 apply
            try {
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'start' });
                const folderId = await this.drive.ensureFolderPath([...restorePointPath, entry.kind]);
                const currentSnapshot = await this.exportSnapshot(entry.kind);
                await this.drive.uploadJson(folderId, restorePointFilename, currentSnapshot);
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'done', filename: restorePointFilename });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'error', error: message });
                items.push({ kind: entry.kind, status: 'aborted', error: message });
                continue;
            }
            // download → apply：任一步失敗標記 error，其他項繼續
            let step = 'download';
            try {
                onProgress?.({ kind: entry.kind, step: 'download', state: 'start' });
                const snapshot = await this.downloadSnapshot(entry.kind, entry.latest.fileId);
                onProgress?.({ kind: entry.kind, step: 'download', state: 'done', filename: entry.latest.filename });
                step = 'apply';
                onProgress?.({ kind: entry.kind, step: 'apply', state: 'start' });
                await this.applySnapshot(snapshot);
                onProgress?.({ kind: entry.kind, step: 'apply', state: 'done' });
                items.push({ kind: entry.kind, status: 'done', filename: entry.latest.filename });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                onProgress?.({ kind: entry.kind, step, state: 'error', error: message });
                items.push({ kind: entry.kind, status: 'error', error: message });
            }
        }
        return { items, restorePointPath };
    }
    async exportSnapshot(kind) {
        if (kind === 'character') {
            return this.tavern.exportCharacter();
        }
        if (kind === 'world') {
            return this.tavern.exportWorld();
        }
        if (kind === 'persona') {
            return this.tavern.exportPersona();
        }
        if (kind === 'preset') {
            return this.tavern.exportPreset();
        }
        return this.tavern.exportRegex();
    }
    async downloadSnapshot(kind, fileId) {
        const downloaded = await this.drive.downloadJson(fileId);
        if (!downloaded || typeof downloaded !== 'object') {
            throw new Error(`環境備份 ${kind} 內容格式錯誤`);
        }
        const snapshot = downloaded;
        if (snapshot.kind !== kind || typeof snapshot.exportedAt !== 'string') {
            throw new Error(`環境備份 ${kind} 內容格式錯誤`);
        }
        return snapshot;
    }
    async applySnapshot(snapshot) {
        if (snapshot.kind === 'character') {
            await this.tavern.applyCharacter(snapshot);
            return;
        }
        if (snapshot.kind === 'world') {
            await this.tavern.applyWorld(snapshot);
            return;
        }
        if (snapshot.kind === 'persona') {
            await this.tavern.applyPersona(snapshot);
            return;
        }
        if (snapshot.kind === 'preset') {
            await this.tavern.applyPreset(snapshot);
            return;
        }
        await this.tavern.applyRegex(snapshot);
    }
}
function EnvironmentRestoreService_environmentItemPath(meta, kind) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

;// ./src/drive/MemoryDriveClient.ts

const MemoryDriveClient_RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;
class MemoryDriveClient {
    items = new Map();
    nextId = 1;
    nextError = null;
    injectError(status, message = `Injected Drive error ${status}`) {
        this.nextError = new DriveError(message, status, status === 401 ? 'unauthorized' : 'injected');
    }
    forceCreateFolder(name, parentId) {
        return this.createItem({ name, parentId, type: 'folder' });
    }
    async findFoldersByName(name, parentId) {
        this.throwIfNeeded();
        return [...this.items.values()].filter(item => item.type === 'folder' && item.name === name && item.parentId === parentId);
    }
    async ensureFolder(name, parentId) {
        this.throwIfNeeded();
        const existing = [...this.items.values()].find(item => item.type === 'folder' && item.name === name && item.parentId === parentId);
        if (existing) {
            return existing;
        }
        return this.createItem({ name, parentId, type: 'folder' });
    }
    async uploadJson(parentId, name, data) {
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return this.uploadText(parentId, name, content, 'application/json');
    }
    async uploadText(parentId, name, content, mimeType = 'text/plain; charset=UTF-8') {
        this.throwIfNeeded();
        this.assertFolder(parentId);
        const item = this.createItem({
            name,
            parentId,
            type: 'file',
            mimeType,
            content
        });
        return {
            ...item,
            uploadKind: new TextEncoder().encode(content).byteLength > MemoryDriveClient_RESUMABLE_THRESHOLD_BYTES ? 'resumable' : 'multipart'
        };
    }
    async listFiles(parentId) {
        this.throwIfNeeded();
        this.assertFolder(parentId);
        return [...this.items.values()]
            .filter(item => item.type === 'file' && item.parentId === parentId)
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    async downloadJson(fileId) {
        this.throwIfNeeded();
        const item = this.items.get(fileId);
        if (!item || item.type !== 'file') {
            throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
        }
        return JSON.parse(item.content ?? 'null');
    }
    async downloadText(fileId) {
        this.throwIfNeeded();
        const item = this.items.get(fileId);
        if (!item || item.type !== 'file') {
            throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
        }
        return item.content ?? '';
    }
    async deleteFile(fileId) {
        this.throwIfNeeded();
        const item = this.items.get(fileId);
        if (!item || item.type !== 'file') {
            throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
        }
        this.items.delete(fileId);
    }
    snapshot() {
        return [...this.items.values()].map(item => ({ ...item }));
    }
    createItem(input) {
        const now = new Date().toISOString();
        const item = {
            ...input,
            id: `mem_${this.nextId++}`,
            createdAt: now,
            updatedAt: now
        };
        this.items.set(item.id, item);
        return item;
    }
    throwIfNeeded() {
        if (!this.nextError) {
            return;
        }
        const error = this.nextError;
        this.nextError = null;
        throw error;
    }
    assertFolder(folderId) {
        const folder = this.items.get(folderId);
        if (!folder || folder.type !== 'folder') {
            throw new DriveError(`Folder not found: ${folderId}`, 404, 'not_found');
        }
    }
}

;// ./src/tavern.ts

function createTavernApi() {
    let currentChatFileName = null;
    return {
        isAvailable() {
            const globals = globalThis;
            return typeof globals.getVariables === 'function' || typeof globals.getCurrentCharacterName === 'function';
        },
        getContext(chatFileName = currentChatFileName) {
            currentChatFileName = chatFileName ?? currentChatFileName;
            const globals = globalThis;
            const meta = getChatMetaFromGlobals();
            return {
                characterName: typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null,
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
            const globals = globalThis;
            if (typeof globals.insertOrAssignVariables !== 'function') {
                throw new Error('酒館助手 chat 變數 API 不可用');
            }
            globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
        },
        getChatAdapter() {
            return createTavernChatAdapter();
        },
        onChatChanged(handler) {
            const globals = globalThis;
            const eventName = globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed';
            if (typeof globals.eventOn !== 'function') {
                return () => undefined;
            }
            const listener = (chatFileName) => {
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
            const globals = globalThis;
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
            const globals = globalThis;
            const notifier = globals.toastr?.[kind];
            if (typeof notifier === 'function') {
                notifier(message);
                return;
            }
            console.log(`[TavernRoamer] ${message}`);
        }
    };
}
function createTavernChatAdapter() {
    const globals = globalThis;
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
            };
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
            const books = Object.fromEntries(await Promise.all(bookNames.map(async (name) => [name, await globals.getWorldbook(name)])));
            return {
                kind: 'world',
                exportedAt: new Date().toISOString(),
                bindings,
                books
            };
        },
        async exportPersona() {
            if (typeof globals.getPersona !== 'function') {
                throw new Error('Persona export API is unavailable');
            }
            const data = await globals.getPersona('current');
            return {
                kind: 'persona',
                exportedAt: new Date().toISOString(),
                name: readOptionalString(data?.name) ?? this.getCurrentCharacterName(),
                data
            };
        },
        async exportPreset() {
            const context = getSillyTavernContext();
            const manager = context?.getPresetManager?.('textgenerationwebui');
            const name = typeof manager?.getSelectedPresetName === 'function' ? manager.getSelectedPresetName() : null;
            if (!name || typeof manager?.getPresetSettings !== 'function') {
                throw new Error('Preset export API is unavailable');
            }
            return {
                kind: 'preset',
                exportedAt: new Date().toISOString(),
                name,
                data: manager.getPresetSettings(name)
            };
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
            };
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
            const result = await response.json();
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
                await globals.deleteChatMessages(Array.from({ length: lastMessageId + 1 }, (_value, index) => index), { refresh: 'none' });
            }
            await globals.createChatMessages(chatPackage.messages.map(message => toCreatableChatMessage(message)), { insert_before: 'end', refresh: 'all' });
            if (typeof globals.setChatMessages === 'function') {
                await globals.setChatMessages(chatPackage.messages.map((message, index) => toRestorableChatMessage(message, index)), { refresh: 'all' });
            }
            if (chatPackage.chat_worldbook && typeof globals.rebindChatWorldbook === 'function') {
                await globals.rebindChatWorldbook('current', chatPackage.chat_worldbook);
            }
            if (typeof globals.replaceVariables === 'function') {
                globals.replaceVariables(chatPackage.chat_variables, { type: 'chat' });
            }
            else if (typeof globals.insertOrAssignVariables === 'function') {
                globals.insertOrAssignVariables(chatPackage.chat_variables, { type: 'chat' });
            }
        }
    };
}
async function getWorldBindings(globals) {
    const chat = typeof globals.getChatWorldbookName === 'function' ? await globals.getChatWorldbookName('current') : null;
    const characterBindings = normalizeStringArray(typeof globals.getCharWorldbookNames === 'function' ? await globals.getCharWorldbookNames('current') : []);
    const globalEnabled = normalizeStringArray(typeof globals.getGlobalWorldbookNames === 'function' ? await globals.getGlobalWorldbookNames() : []);
    return {
        chat: readOptionalString(chat) ?? null,
        char_primary: characterBindings[0] ?? null,
        char_additional: characterBindings.slice(1),
        global_enabled: globalEnabled
    };
}
function getCurrentRawChatInfo() {
    const context = getSillyTavernContext();
    const chatId = readOptionalString(context?.getCurrentChatId?.()) ?? readOptionalString(context?.chatId);
    const contextFileName = readOptionalString(context?.chatFileName) ??
        readOptionalString(context?.chat_file_name) ??
        readOptionalString(context?.chat?.file_name);
    const characterId = readOptionalString(context?.characterId);
    const characterIndex = characterId === undefined ? Number.NaN : Number(characterId);
    const character = Array.isArray(context?.characters) && Number.isInteger(characterIndex) ? context.characters[characterIndex] : null;
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
function getSillyTavernContext() {
    const candidates = [globalThis, safeParentWindow()].filter(Boolean);
    for (const candidate of candidates) {
        const provider = candidate.SillyTavern;
        const context = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
        if (context && typeof context === 'object') {
            return context;
        }
    }
    return null;
}
function safeParentWindow() {
    try {
        const currentWindow = globalThis;
        return currentWindow.parent && currentWindow.parent !== currentWindow
            ? currentWindow.parent
            : null;
    }
    catch {
        return null;
    }
}
function getRequestHeaders() {
    const headers = getSillyTavernContext()?.getRequestHeaders?.();
    if (headers && typeof headers === 'object') {
        return headers;
    }
    return { 'Content-Type': 'application/json' };
}
function findPresetOptionValue(manager, name) {
    if (typeof manager.findPreset === 'function') {
        const found = manager.findPreset(name);
        return typeof found === 'string' ? found : null;
    }
    const selected = manager.getSelectedPreset?.();
    return typeof selected === 'string' ? selected : null;
}
function parseRawChatMessages(content) {
    return content
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
}
function countRawChatMessages(content) {
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
function toCreatableChatMessage(message) {
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
function toRestorableChatMessage(message, index) {
    const current = currentSwipeSnapshot(message);
    return omitUndefined({
        ...message,
        message_id: index,
        message: current.message,
        data: current.data,
        extra: current.extra
    });
}
function currentSwipeSnapshot(message) {
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
function normalizeMessageRole(message) {
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
function clampSwipeId(value, length) {
    if (!Number.isInteger(value) || value < 0) {
        return 0;
    }
    return Math.min(value, Math.max(0, length - 1));
}
function readOptionalString(value) {
    return typeof value === 'string' ? value : undefined;
}
function readOptionalBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function readOptionalRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    }
    if (typeof value === 'string' && value.trim()) {
        return [value];
    }
    return [];
}
function uniqueNonEmpty(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))];
}
function omitUndefined(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function getChatMetaFromGlobals() {
    const globals = globalThis;
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
function isChatMeta(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const meta = value;
    return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string';
}

;// ./src/selfCheck.ts






const cases = [];
function registerSelfCheck(testCase) {
    if (cases.some(existing => existing.id === testCase.id)) {
        return;
    }
    cases.push(testCase);
}
function getSelfCheckCases() {
    return [...cases];
}
async function runSelfChecks() {
    const results = [];
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
        }
        catch (error) {
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
function registerPhase0SelfChecks() {
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
            const downloaded = await drive.downloadJson(file.id);
            drive.injectError(429);
            try {
                await drive.listFiles(folder.id);
                return { status: 'fail', message: '429 注入後沒有拋錯' };
            }
            catch {
                return downloaded.ok
                    ? { status: 'pass', message: '可建立資料夾/檔案，且可注入 429/5xx/401 錯誤' }
                    : { status: 'fail', message: '下載內容不一致', details: downloaded };
            }
        }
    });
}
function registerApiSpikeSelfChecks() {
    registerSelfCheck({
        id: 'api.chat.variables',
        label: 'chat 變數讀寫',
        async run() {
            const globals = globalThis;
            if (typeof globals.getVariables !== 'function' || typeof globals.insertOrAssignVariables !== 'function') {
                return { status: 'skip', message: '不在酒館助手環境，略過真實 API 驗證' };
            }
            const marker = `chat_self_check_${Date.now()}`;
            const before = globals.getVariables({ type: 'chat' });
            const previous = before?.[CHAT_META_KEY];
            globals.insertOrAssignVariables({
                [CHAT_META_KEY]: {
                    chat_id: marker,
                    role_key: 'self_check',
                    device_name: 'self_check'
                }
            }, { type: 'chat' });
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
            const globals = globalThis;
            if (typeof globals.getCharacter !== 'function' || typeof globals.createOrReplaceCharacter !== 'function') {
                return { status: 'skip', message: '角色卡 API 不可用' };
            }
            const currentName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
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
            const globals = globalThis;
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
            const globals = globalThis;
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
            const globals = globalThis;
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
            const globals = globalThis;
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
            const globals = globalThis;
            const names = ['getWorldbook', 'replaceWorldbook', 'importRawWorldbook'];
            const missing = names.filter(name => typeof globals[name] !== 'function');
            return missing.length === 0
                ? { status: 'pass', message: 'worldbook 主要 API 都可用' }
                : { status: 'skip', message: `缺少 API: ${missing.join(', ')}` };
        }
    });
}
function registerDriveSelfChecks(drive, isConnected) {
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
            const downloaded = await drive.downloadJson(uploaded.id);
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
function registerUiSelfChecks(probe) {
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
function registerChatSelfChecks() {
    registerSelfCheck({
        id: 'chat.pack.roundtrip',
        label: '聊天 pack/unpack 來回',
        async run() {
            const globals = globalThis;
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
            const globals = globalThis;
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
                await globals.setChatMessages([{ message_id: originalMessages[0]?.message_id ?? 0, message: `[TavernRoamer self-check] ${Date.now()}` }], { refresh: 'none' });
                await adapter.replaceChat(packed);
                const restored = adapter.getMessages();
                const same = JSON.stringify(restored) === JSON.stringify(originalMessages);
                return same
                    ? { status: 'pass', message: `覆寫還原一致，耗時 ${Math.round(performance.now() - startedAt)}ms` }
                    : { status: 'fail', message: '覆寫還原後訊息不一致', details: { originalMessages, restored } };
            }
            finally {
                await adapter.replaceChat(packed);
            }
        }
    });
}

;// ./src/ui.ts



const BACKUP_ITEM_LABELS = {
    character: '角色卡',
    world: '世界書',
    persona: 'Persona',
    preset: 'Preset',
    regex: 'Regex'
};
const DEFAULT_BACKUP_ITEMS = ['character', 'world', 'persona', 'preset', 'regex'];
// 未連線 Drive 時需 disable 的操作按鈕（手冊 14.4 防呆）
const DRIVE_GUARDED_ACTIONS = ['manual-upload', 'download-latest', 'backup-environment', 'restore-environment'];
const DRIVE_GUARD_TITLE = '請先連線 Google Drive';
/** 狀態 → 色點 pill 文案與色調（手冊 14.3）。 */
function statusPill(status) {
    switch (status) {
        case 'synced':
            return { label: '已是最新', tone: 'green' };
        case 'newer_remote':
            return { label: '雲端有新版', tone: 'yellow' };
        case 'local_dirty':
            return { label: '本地有未上傳變更', tone: 'orange' };
        case 'not_connected':
            return { label: '未連線', tone: 'grey' };
        default:
            return { label: '未知', tone: 'grey' };
    }
}
/** 待傳佇列文案（手冊 14.3）：>0 顯示「待傳 N 筆」警示，=0 顯示正常色的「無」。 */
function formatPendingLabel(count) {
    if (!Number.isFinite(count) || count <= 0) {
        return { text: '無', visible: false, tone: 'normal' };
    }
    return { text: `待傳 ${Math.floor(count)} 筆`, visible: true, tone: 'warn' };
}
/** 自動同步文案（手冊 14.3）。 */
function formatAutoSyncLabel(settings) {
    return settings.autoSyncEnabled ? `每 ${settings.autoSyncEveryN} 則` : '已停用';
}
/** 進度清單頂部 n/m 計數（n = 已結束項數）。 */
function progressRatioLabel(settled, total) {
    return `${settled}/${total}`;
}
function createPanel(options) {
    let root = null;
    let context = options.getContext();
    let driveState = options.getDriveState();
    let progressOp = null;
    let progressTitle = '';
    let progressRows = [];
    function mount() {
        if (root) {
            return;
        }
        const hostDocument = getHostDocument();
        root = hostDocument.createElement('section');
        root.id = 'tavern-roamer-panel';
        root.innerHTML = renderPanel(loadSettings(), context, driveState);
        const mountPoint = findMountPoint(hostDocument);
        if (mountPoint === hostDocument.body) {
            root.classList.add('tr-floating');
        }
        injectStyle(hostDocument);
        mountPoint.append(root);
        bindEvents();
        applyConnectionGuards();
    }
    function updateContext(nextContext, info) {
        context = nextContext;
        if (!root) {
            return;
        }
        setText('character', context.characterName ?? '未選取');
        setText('chat-id', context.chatId ?? '尚未同步');
        setText('chat-file', context.chatFileName ?? '未知');
        const pill = statusPill(context.status);
        const statusEl = root.querySelector('[data-field="status"]');
        if (statusEl) {
            statusEl.className = `tr-pill tr-tone-${pill.tone}`;
            statusEl.textContent = pill.label;
        }
        const autoEl = root.querySelector('[data-field="auto-sync"]');
        if (autoEl) {
            autoEl.textContent = formatAutoSyncLabel(loadSettings());
        }
        if (info) {
            setText('last-synced', formatLastSyncedLabel(info.lastSyncedVersion));
            const queueEl = root.querySelector('[data-field="queue"]');
            if (queueEl) {
                const queue = formatPendingLabel(info.pendingUploads);
                queueEl.textContent = queue.text;
                queueEl.classList.toggle('tr-warn-text', queue.tone === 'warn');
            }
        }
    }
    function updateDriveStatus(nextState) {
        driveState = nextState;
        if (!root) {
            return;
        }
        setText('drive', driveState.connected ? '已連線' : '未連線');
        const email = root.querySelector('[data-field="drive-email"]');
        if (email) {
            email.textContent = driveState.email ?? (driveState.error ? `錯誤：${driveState.error}` : '-');
        }
        applyConnectionGuards();
    }
    function probe() {
        const panelEl = findMountedPanel();
        const drawer = panelEl?.querySelector('.inline-drawer') ?? null;
        const toggle = panelEl?.querySelector('.inline-drawer-toggle') ?? null;
        const content = panelEl?.querySelector('.inline-drawer-content') ?? null;
        return {
            mounted: Boolean(panelEl),
            hasInlineDrawer: Boolean(drawer && toggle && content),
            toggleReady: Boolean(toggle && content),
            details: {
                id: panelEl?.id ?? null,
                mountedTo: panelEl?.parentElement?.id ?? null,
                floating: panelEl?.classList.contains('tr-floating') ?? false
            }
        };
    }
    // ── 進度清單 ───────────────────────────────────────────────────
    function renderProgress() {
        const el = root?.querySelector('[data-field="progress"]');
        if (!el) {
            return;
        }
        if (progressRows.length === 0) {
            el.innerHTML = '';
            el.hidden = true;
            return;
        }
        el.hidden = false;
        const settled = progressRows.filter(row => isSettled(row.state)).length;
        const total = progressRows.length;
        const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
        el.innerHTML = `
      <div class="tr-progress-head">
        <span class="tr-progress-title">${escapeHtml(progressTitle)}</span>
        <span class="tr-progress-count">${progressRatioLabel(settled, total)}</span>
      </div>
      <div class="tr-progressbar"><i style="width:${pct}%"></i></div>
      <ul class="tr-progress-list">
        ${progressRows.map(renderProgressRow).join('')}
      </ul>
    `;
    }
    function beginProgress(op, title, rows) {
        progressOp = op;
        progressTitle = title;
        progressRows = rows;
        renderProgress();
    }
    /** 為指定 kinds 建立/重置進度列（重試時保留其他列）。 */
    function ensureRows(kinds) {
        for (const kind of kinds) {
            const existing = progressRows.find(row => row.key === kind);
            const fresh = { key: kind, label: BACKUP_ITEM_LABELS[kind], state: 'pending', detail: '等待中', canRetry: false };
            if (existing) {
                Object.assign(existing, fresh);
            }
            else {
                progressRows.push(fresh);
            }
        }
    }
    function patchRow(key, patch) {
        const row = progressRows.find(item => item.key === key);
        if (row) {
            Object.assign(row, patch);
            renderProgress();
        }
    }
    async function runBackup(kinds) {
        if (progressOp !== 'backup' || progressRows.length === 0) {
            beginProgress('backup', '備份完整環境', []);
        }
        progressOp = 'backup';
        progressTitle = '備份完整環境';
        ensureRows(kinds);
        renderProgress();
        try {
            const results = await options.onBackupEnvironment(kinds, applyBackupEvent);
            applyBackupResults(results);
        }
        catch (error) {
            for (const kind of kinds) {
                patchRow(kind, { state: 'error', detail: `失敗：${ui_errorMessage(error)}`, canRetry: true });
            }
        }
        renderProgress();
    }
    function applyBackupEvent(event) {
        if (event.state === 'start') {
            patchRow(event.kind, { state: 'active', detail: event.step === 'upload' ? '上傳中…' : '匯出中…' });
            return;
        }
        if (event.state === 'error') {
            patchRow(event.kind, { state: 'error', detail: `失敗：${event.error ?? '未知錯誤'}`, canRetry: true });
            return;
        }
        if (event.step === 'upload') {
            patchRow(event.kind, { state: 'done', detail: event.filename ?? '完成', canRetry: false });
        }
    }
    function applyBackupResults(results) {
        for (const result of results) {
            if (result.status === 'done') {
                patchRow(result.kind, { state: 'done', detail: result.filename ?? '完成', canRetry: false });
            }
            else {
                patchRow(result.kind, { state: 'error', detail: `失敗：${result.error ?? '未知錯誤'}`, canRetry: true });
            }
        }
    }
    async function runRestore(kinds) {
        if (progressOp !== 'restore' || progressRows.length === 0) {
            beginProgress('restore', '還原環境', []);
        }
        progressOp = 'restore';
        progressTitle = '還原環境';
        ensureRows(kinds);
        renderProgress();
        try {
            const result = await options.onRestoreEnvironment(kinds, applyRestoreEvent);
            applyRestoreResults(result.items);
        }
        catch (error) {
            for (const kind of kinds) {
                patchRow(kind, { state: 'error', detail: `失敗：${ui_errorMessage(error)}`, canRetry: true });
            }
        }
        renderProgress();
    }
    function applyRestoreEvent(event) {
        if (event.state === 'error') {
            if (event.step === 'backup_current') {
                patchRow(event.kind, { state: 'aborted', detail: `覆蓋前備份失敗，已中止：${event.error ?? ''}`, canRetry: true });
            }
            else {
                patchRow(event.kind, { state: 'error', detail: `失敗：${event.error ?? '未知錯誤'}`, canRetry: true });
            }
            return;
        }
        if (event.state === 'start') {
            const detail = event.step === 'backup_current' ? '備份現況…' : event.step === 'download' ? '下載中…' : '套用中…';
            patchRow(event.kind, { state: 'active', detail });
            return;
        }
        // done
        if (event.step === 'download' && event.filename) {
            patchRow(event.kind, { detail: event.filename });
        }
        if (event.step === 'apply') {
            patchRow(event.kind, { state: 'done', canRetry: false });
        }
    }
    function applyRestoreResults(items) {
        for (const item of items) {
            if (item.status === 'done') {
                patchRow(item.kind, { state: 'done', detail: item.filename ?? '完成', canRetry: false });
            }
            else if (item.status === 'skipped') {
                patchRow(item.kind, { state: 'skipped', detail: '雲端無備份，略過', canRetry: false });
            }
            else if (item.status === 'aborted') {
                patchRow(item.kind, { state: 'aborted', detail: `覆蓋前備份失敗，已中止${item.error ? `：${item.error}` : ''}`, canRetry: true });
            }
            else {
                patchRow(item.kind, { state: 'error', detail: `失敗：${item.error ?? '未知錯誤'}`, canRetry: true });
            }
        }
    }
    async function runSingle(op) {
        const title = op === 'upload' ? '手動上傳目前聊天' : '下載並覆蓋';
        const activeDetail = op === 'upload' ? '上傳中…' : '下載並覆蓋中…';
        beginProgress(op, title, [{ key: op, label: '目前聊天', state: 'active', detail: activeDetail, canRetry: false }]);
        try {
            const filename = op === 'upload' ? await options.onManualUpload() : await options.onDownloadLatest();
            patchRow(op, { state: 'done', detail: op === 'upload' ? filename : `已覆蓋為 ${filename}`, canRetry: false });
        }
        catch (error) {
            patchRow(op, { state: 'error', detail: `失敗：${ui_errorMessage(error)}`, canRetry: true });
        }
    }
    function retryRow(key) {
        if (progressOp === 'backup' && isItemKind(key)) {
            void runBackup([key]);
        }
        else if (progressOp === 'restore' && isItemKind(key)) {
            void runRestore([key]);
        }
        else if (progressOp === 'upload') {
            void runSingle('upload');
        }
        else if (progressOp === 'download') {
            void runSingle('download');
        }
    }
    // ── 事件綁定 ───────────────────────────────────────────────────
    function bindEvents() {
        if (!root) {
            return;
        }
        root.querySelector('[data-action="save"]')?.addEventListener('click', () => {
            if (!root)
                return;
            const settings = collectSettings(root);
            const saved = saveSettings(settings);
            options.onSave(saved);
            refreshSettingsGuidance(saved);
            const autoEl = root.querySelector('[data-field="auto-sync"]');
            if (autoEl)
                autoEl.textContent = formatAutoSyncLabel(saved);
            setReport('設定已儲存');
        });
        root.querySelector('[data-action="connect-drive"]')?.addEventListener('click', async () => {
            setReport('Google Drive 授權中...');
            try {
                if (!root)
                    return;
                const saved = saveSettings(collectSettings(root));
                options.onSave(saved);
                refreshSettingsGuidance(saved);
                const state = await options.onConnectDrive();
                updateDriveStatus(state);
                setReport(state.connected ? 'Google Drive 已連線' : `Google Drive 未連線：${state.error ?? '未知錯誤'}`);
            }
            catch (error) {
                updateDriveStatus({ connected: false, email: null, error: ui_errorMessage(error) });
                setReport(ui_errorMessage(error));
            }
        });
        root.querySelector('[data-action="manual-upload"]')?.addEventListener('click', () => {
            void runSingle('upload');
        });
        root.querySelector('[data-action="download-latest"]')?.addEventListener('click', async () => {
            const ok = await confirmDialog('下載並覆蓋', '<p>此操作會以雲端最新版本<b>覆蓋目前聊天內容</b>，覆蓋後無法復原。</p><p>確定要繼續嗎？</p>', '此操作會以雲端最新版本覆蓋目前聊天內容，覆蓋後無法復原。確定要繼續嗎？');
            if (!ok) {
                setReport('已取消下載覆蓋');
                return;
            }
            void runSingle('download');
        });
        root.querySelector('[data-action="backup-environment"]')?.addEventListener('click', () => {
            const selectedItems = collectSelectedItems();
            if (selectedItems.length === 0) {
                setReport('請先勾選至少一個環境項目');
                return;
            }
            beginProgress('backup', '備份完整環境', []);
            void runBackup(selectedItems);
        });
        root.querySelector('[data-action="restore-environment"]')?.addEventListener('click', async () => {
            const selectedItems = collectSelectedItems();
            if (selectedItems.length === 0) {
                setReport('請先勾選至少一個環境項目');
                return;
            }
            let overwrite = selectedItems;
            let skipped = [];
            try {
                const preview = await options.onPreviewRestore(selectedItems);
                overwrite = selectedItems.filter(kind => preview[kind]);
                skipped = selectedItems.filter(kind => !preview[kind]);
            }
            catch {
                // 預檢失敗：保守起見全部視為將被覆蓋，仍照常二次確認
            }
            const ok = await confirmDialog('還原環境', buildRestoreConfirmHtml(overwrite, skipped), buildRestoreConfirmText(overwrite, skipped));
            if (!ok) {
                setReport('已取消還原');
                return;
            }
            beginProgress('restore', '還原環境', []);
            void runRestore(selectedItems);
        });
        root.querySelector('[data-action="self-check"]')?.addEventListener('click', async () => {
            setReport('自檢執行中...');
            const results = await runSelfChecks();
            setReport(results.map(result => `${statusIcon(result.status)} ${result.label}: ${result.message} (${result.durationMs}ms)`).join('\n'));
        });
        // 進度清單「重試」以事件委派處理（每次 renderProgress 會重寫 innerHTML）
        root.querySelector('[data-field="progress"]')?.addEventListener('click', event => {
            const target = event.target?.closest('[data-retry-key]');
            const key = target?.getAttribute('data-retry-key');
            if (key) {
                retryRow(key);
            }
        });
        // 連線與設定小節收合（自寫 toggle：非主 drawer，酒館全域委派不涵蓋）
        const settingsToggle = root.querySelector('[data-action="toggle-settings"]');
        settingsToggle?.addEventListener('click', () => {
            const content = root?.querySelector('[data-settings-content]');
            const icon = settingsToggle.querySelector('.tr-section-icon');
            if (!content)
                return;
            const collapsed = content.hidden;
            content.hidden = !collapsed;
            icon?.classList.toggle('tr-collapsed', !collapsed);
        });
        // 浮動模式（掛到 body、非 extensions_settings）宿主沒有 inline-drawer 全域委派，
        // 自行補一個收合 toggle；掛到宿主面板時交給酒館的全域點擊委派處理。
        if (root.classList.contains('tr-floating')) {
            const toggle = root.querySelector('.inline-drawer-toggle');
            const content = root.querySelector('.inline-drawer-content');
            const icon = root.querySelector('.inline-drawer-icon');
            toggle?.addEventListener('click', () => {
                if (!content) {
                    return;
                }
                const isOpen = content.style.display !== 'none';
                content.style.display = isOpen ? 'none' : '';
                icon?.classList.toggle('down');
                icon?.classList.toggle('up');
            });
        }
    }
    function applyConnectionGuards() {
        if (!root) {
            return;
        }
        for (const action of DRIVE_GUARDED_ACTIONS) {
            const button = root.querySelector(`[data-action="${action}"]`);
            if (!button) {
                continue;
            }
            if (driveState.connected) {
                button.disabled = false;
                button.removeAttribute('title');
                button.classList.remove('tr-disabled');
            }
            else {
                button.disabled = true;
                button.title = DRIVE_GUARD_TITLE;
                button.classList.add('tr-disabled');
            }
        }
    }
    function refreshSettingsGuidance(settings) {
        if (!root) {
            return;
        }
        const guidance = root.querySelector('[data-field="guidance"]');
        if (guidance) {
            guidance.hidden = Boolean(settings.googleClientId.trim());
        }
    }
    function collectSelectedItems() {
        if (!root) {
            return [...DEFAULT_BACKUP_ITEMS];
        }
        return DEFAULT_BACKUP_ITEMS.filter(item => Boolean(root?.querySelector(`[data-input="backup-${item}"]`)?.checked));
    }
    function setText(field, value) {
        const el = root?.querySelector(`[data-field="${field}"]`);
        if (el) {
            el.textContent = value;
        }
    }
    function setReport(text) {
        const report = root?.querySelector('[data-field="report"]');
        if (report) {
            report.textContent = text;
        }
    }
    function renderProgressRow(row) {
        const retry = row.canRetry
            ? `<button type="button" class="menu_button tr-retry" data-retry-key="${escapeAttribute(row.key)}">重試</button>`
            : '';
        return `
      <li class="tr-progress-row tr-row-${row.state}">
        <span class="tr-row-icon">${progressIcon(row.state)}</span>
        <span class="tr-row-label">${escapeHtml(row.label)}</span>
        <span class="tr-row-detail">${escapeHtml(row.detail)}</span>
        ${retry}
      </li>
    `;
    }
    return { mount, updateContext, updateDriveStatus, probe };
}
// ── 版面 ───────────────────────────────────────────────────────────
function renderPanel(settings, context, driveState) {
    const pill = statusPill(context.status);
    const pending = formatPendingLabel(0);
    const settingsCollapsed = Boolean(settings.googleClientId.trim());
    return `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>TavernRoamer</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="tr-body">

          <section class="tr-section" data-section="status">
            <div class="tr-grid">
              <span>Google Drive</span><b data-field="drive">${driveState.connected ? '已連線' : '未連線'}</b>
              <span>連線帳號</span><b data-field="drive-email">${escapeHtml(driveState.email ?? '-')}</b>
              <span>目前角色</span><b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b>
              <span>聊天檔</span><b data-field="chat-file">${escapeHtml(context.chatFileName ?? '未知')}</b>
              <span>chat_id</span><b data-field="chat-id">${escapeHtml(context.chatId ?? '尚未同步')}</b>
              <span>狀態</span><b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b>
              <span>最後同步</span><b data-field="last-synced">—</b>
              <span>待傳佇列</span><b data-field="queue">${pending.text}</b>
              <span>自動同步</span><b data-field="auto-sync">${formatAutoSyncLabel(settings)}</b>
            </div>
          </section>

          <section class="tr-section" data-section="daily">
            <div class="tr-section-title">日常操作</div>
            <div class="tr-actions flex-container flexGap5">
              ${iconButton('manual-upload', 'fa-upload', '手動上傳目前聊天')}
              ${iconButton('download-latest', 'fa-download', '下載並覆蓋')}
            </div>
          </section>

          <section class="tr-section" data-section="environment">
            <div class="tr-section-title">環境備份 / 還原</div>
            <fieldset class="tr-fieldset">
              <legend>環境備份項目</legend>
              ${DEFAULT_BACKUP_ITEMS.map(item => `
                <label class="checkbox_label">
                  <input data-input="backup-${item}" type="checkbox" checked />
                  <span>${BACKUP_ITEM_LABELS[item]}</span>
                </label>
              `).join('')}
            </fieldset>
            <div class="tr-actions flex-container flexGap5">
              ${iconButton('backup-environment', 'fa-box-archive', '備份完整環境')}
              ${iconButton('restore-environment', 'fa-box-open', '還原環境')}
            </div>
            <div class="tr-progress" data-field="progress" aria-live="polite" hidden></div>
          </section>

          <section class="tr-section" data-section="settings">
            <div class="tr-section-title tr-section-toggle" data-action="toggle-settings">
              <span>連線與設定</span>
              <i class="fa-solid fa-chevron-down tr-section-icon ${settingsCollapsed ? 'tr-collapsed' : ''}"></i>
            </div>
            <div class="tr-settings-content" data-settings-content ${settingsCollapsed ? 'hidden' : ''}>
              <p class="tr-guidance" data-field="guidance" ${settingsCollapsed ? 'hidden' : ''}>
                首次使用請先填入 Google Client ID 並點「連線 Google Drive」完成授權，才能上傳、下載與備份。
              </p>
              <label class="tr-field">
                <span>Google Client ID</span>
                <input class="text_pole" data-input="googleClientId" value="${escapeAttribute(settings.googleClientId)}" autocomplete="off" />
              </label>
              <label class="tr-field">
                <span>裝置名稱</span>
                <input class="text_pole" data-input="deviceName" value="${escapeAttribute(settings.deviceName)}" autocomplete="off" />
              </label>
              <label class="tr-field tr-inline">
                <span>自動同步每 N 則</span>
                <input class="text_pole" data-input="autoSyncEveryN" type="number" min="1" step="1" value="${settings.autoSyncEveryN}" />
              </label>
              <label class="checkbox_label">
                <input data-input="autoSyncEnabled" type="checkbox" ${settings.autoSyncEnabled ? 'checked' : ''} />
                <span>啟用自動同步</span>
              </label>
              <div class="tr-actions flex-container flexGap5">
                ${iconButton('connect-drive', 'fa-plug', '連線 Google Drive')}
                ${iconButton('save', 'fa-save', '儲存設定')}
                ${iconButton('self-check', 'fa-stethoscope', '自檢')}
              </div>
            </div>
          </section>

          <pre data-field="report" class="tr-report" aria-live="polite"></pre>
        </div>
      </div>
    </div>
  `;
}
function iconButton(action, icon, label) {
    return `<button type="button" class="menu_button menu_button_icon" data-action="${action}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
}
function progressIcon(state) {
    switch (state) {
        case 'active':
            return '<i class="fa-solid fa-spinner fa-spin"></i>';
        case 'done':
            return '<span class="tr-ok">✓</span>';
        case 'error':
            return '<span class="tr-err">✗</span>';
        case 'aborted':
            return '<span class="tr-abort">⚠</span>';
        case 'skipped':
        case 'pending':
        default:
            return '<span class="tr-dot">·</span>';
    }
}
function buildRestoreConfirmHtml(overwrite, skipped) {
    const overwriteText = overwrite.length > 0 ? overwrite.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
    const skippedText = skipped.length > 0 ? skipped.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
    return `
    <p>還原前會先將目前內容備份到雲端 <code>_pre_restore</code>，再以雲端最新版本覆蓋。</p>
    <p><b>將被覆蓋（有雲端備份）：</b>${escapeHtml(overwriteText)}</p>
    <p><b>雲端沒有備份、將略過：</b>${escapeHtml(skippedText)}</p>
    <p>確定要還原嗎？</p>
  `;
}
function buildRestoreConfirmText(overwrite, skipped) {
    const overwriteText = overwrite.length > 0 ? overwrite.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
    const skippedText = skipped.length > 0 ? skipped.map(kind => BACKUP_ITEM_LABELS[kind]).join('、') : '（無）';
    return [
        '還原前會先將目前內容備份到雲端 _pre_restore，再以雲端最新版本覆蓋。',
        `將被覆蓋（有雲端備份）：${overwriteText}`,
        `雲端沒有備份、將略過：${skippedText}`,
        '確定要還原嗎？'
    ].join('\n');
}
async function confirmDialog(title, html, text) {
    try {
        // 優先取宿主酒館的 callGenericPopup（try globalThis.parent 上的 SillyTavern.getContext()）
        const globals = globalThis;
        const provider = globals.parent?.SillyTavern ?? globals.SillyTavern;
        const ctx = typeof provider?.getContext === 'function' ? provider.getContext() : provider;
        const popup = ctx?.callGenericPopup;
        if (typeof popup === 'function') {
            const popupType = ctx?.POPUP_TYPE?.CONFIRM ?? 2;
            const result = await popup(`<h3>${escapeHtml(title)}</h3>${html}`, popupType, '', {
                okButton: '確定',
                cancelButton: '取消'
            });
            return Boolean(result);
        }
    }
    catch {
        // 取不到酒館 popup → 退回 confirm()
    }
    const confirmFn = typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : null;
    return confirmFn ? confirmFn(`${title}\n\n${text}`) : true;
}
function isSettled(state) {
    return state === 'done' || state === 'error' || state === 'aborted' || state === 'skipped';
}
function isItemKind(value) {
    return DEFAULT_BACKUP_ITEMS.includes(value);
}
function ui_errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function collectSettings(root) {
    const current = loadSettings();
    const deviceName = root.querySelector('[data-input="deviceName"]')?.value ?? current.deviceName;
    const googleClientId = root.querySelector('[data-input="googleClientId"]')?.value ?? current.googleClientId;
    const autoSyncEveryN = Number(root.querySelector('[data-input="autoSyncEveryN"]')?.value);
    const autoSyncEnabled = Boolean(root.querySelector('[data-input="autoSyncEnabled"]')?.checked);
    return {
        ...current,
        deviceName,
        googleClientId,
        autoSyncEnabled,
        autoSyncEveryN: Number.isInteger(autoSyncEveryN) && autoSyncEveryN > 0 ? autoSyncEveryN : current.autoSyncEveryN
    };
}
function getHostDocument() {
    try {
        const parentDocument = globalThis.parent?.document;
        if (parentDocument?.querySelector('#extensions_settings2, #extensions_settings')) {
            return parentDocument;
        }
    }
    catch {
        return document;
    }
    return document;
}
function findMountedPanel() {
    try {
        const parentPanel = globalThis.parent?.document?.querySelector('#tavern-roamer-panel');
        if (parentPanel) {
            return parentPanel;
        }
    }
    catch {
        // 跨域或無 parent → 退回自身 document
    }
    return document.querySelector('#tavern-roamer-panel');
}
function findMountPoint(hostDocument) {
    return (hostDocument.querySelector('#extensions_settings2') ??
        hostDocument.querySelector('#extensions_settings') ??
        hostDocument.body);
}
function injectStyle(hostDocument) {
    if (hostDocument.querySelector('#tavern-roamer-style')) {
        return;
    }
    const style = hostDocument.createElement('style');
    style.id = 'tavern-roamer-style';
    style.textContent = `
    /* 掛在宿主面板時，外觀交給酒館的 inline-drawer / menu_button / text_pole；
       這裡只保留佈局，顏色一律吃 --SmartTheme* 主題變數並附 fallback。 */
    #tavern-roamer-panel {
      margin: 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--SmartThemeBodyColor, currentColor);
    }
    #tavern-roamer-panel .tr-body {
      display: grid;
      gap: 14px;
      padding: 8px 0 2px;
    }
    #tavern-roamer-panel .tr-section {
      display: grid;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-section-title {
      font-weight: 600;
      opacity: .82;
      border-bottom: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 18%, transparent));
      padding-bottom: 4px;
    }
    #tavern-roamer-panel .tr-section-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    #tavern-roamer-panel .tr-section-icon {
      transition: transform .15s ease;
    }
    #tavern-roamer-panel .tr-section-icon.tr-collapsed {
      transform: rotate(-90deg);
    }
    #tavern-roamer-panel .tr-grid {
      display: grid;
      grid-template-columns: minmax(90px, max-content) minmax(0, 1fr);
      gap: 6px 12px;
      align-items: baseline;
    }
    #tavern-roamer-panel .tr-grid span,
    #tavern-roamer-panel .tr-field > span,
    #tavern-roamer-panel .tr-fieldset legend {
      opacity: .72;
    }
    #tavern-roamer-panel .tr-grid b {
      font-weight: 600;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    /* 狀態色點 pill：文字吃主題色，顏色由色點呈現，低飽和且暗亮主題皆可讀 */
    #tavern-roamer-panel .tr-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-pill::before {
      content: '';
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--tr-tone, #9aa0a6);
      flex: 0 0 auto;
    }
    #tavern-roamer-panel .tr-tone-green { --tr-tone: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-tone-yellow { --tr-tone: var(--tr-c-yellow, #d6b34a); }
    #tavern-roamer-panel .tr-tone-orange { --tr-tone: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-tone-grey { --tr-tone: var(--tr-c-grey, #9aa0a6); }
    #tavern-roamer-panel .tr-warn-text {
      color: var(--tr-c-orange, #d98a4a);
      font-weight: 700;
    }
    #tavern-roamer-panel .tr-guidance {
      margin: 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 40%, transparent);
      opacity: .95;
    }
    #tavern-roamer-panel .tr-field {
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-inline {
      grid-template-columns: minmax(120px, max-content) minmax(72px, 120px);
      align-items: center;
    }
    #tavern-roamer-panel .tr-fieldset {
      margin: 0;
      padding: 8px 10px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 6px;
      display: grid;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-settings-content {
      display: grid;
      gap: 10px;
    }
    #tavern-roamer-panel .tr-settings-content[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-disabled,
    #tavern-roamer-panel .menu_button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    /* 進度清單 */
    #tavern-roamer-panel .tr-progress {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 18%, transparent));
      border-radius: 6px;
    }
    /* 作者規則會蓋過 UA 的 [hidden]{display:none}，需明確補回，否則空進度框仍會顯示 */
    #tavern-roamer-panel .tr-progress[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-progress-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-progress-count {
      opacity: .72;
      font-variant-numeric: tabular-nums;
    }
    #tavern-roamer-panel .tr-progressbar {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, currentColor 15%, transparent);
    }
    #tavern-roamer-panel .tr-progressbar > i {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--SmartThemeQuoteColor, var(--tr-c-green, #5bbd7a));
      transition: width .2s ease;
    }
    #tavern-roamer-panel .tr-progress-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-progress-row {
      display: grid;
      grid-template-columns: 18px minmax(56px, max-content) minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: center;
    }
    #tavern-roamer-panel .tr-row-detail {
      opacity: .78;
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-row-icon { text-align: center; }
    #tavern-roamer-panel .tr-ok { color: var(--tr-c-green, #5bbd7a); font-weight: 700; }
    #tavern-roamer-panel .tr-err { color: var(--tr-c-red, #d05a5a); font-weight: 700; }
    #tavern-roamer-panel .tr-abort { color: var(--tr-c-orange, #d98a4a); font-weight: 700; }
    #tavern-roamer-panel .tr-dot { opacity: .5; }
    #tavern-roamer-panel .tr-retry {
      padding: 2px 8px;
      font-size: 12px;
    }
    #tavern-roamer-panel .tr-report {
      margin: 0;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 180px;
      padding: 8px;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
      color: var(--SmartThemeBodyColor, currentColor);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-report:empty { display: none; }

    /* 浮動保底：掛到 body（iframe 自身 document）時酒館的元件 class 與主題變數
       不存在，需一組 scoped 保底樣式，只在 .tr-floating 下生效。 */
    #tavern-roamer-panel.tr-floating {
      position: fixed;
      z-index: 100000;
      right: 16px;
      bottom: 16px;
      width: min(420px, calc(100vw - 32px));
      max-height: min(720px, calc(100vh - 32px));
      overflow: auto;
      padding: 12px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 8px;
      background: var(--SmartThemeBlurTintColor, color-mix(in srgb, canvas 96%, currentColor 4%));
      box-shadow: 0 14px 36px var(--black30a, rgba(0, 0, 0, .28));
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      font-weight: 600;
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-icon {
      transition: transform .15s ease;
    }
    #tavern-roamer-panel.tr-floating .inline-drawer-icon.up {
      transform: rotate(180deg);
    }
    #tavern-roamer-panel.tr-floating .menu_button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: inherit;
      background: color-mix(in srgb, currentColor 8%, transparent);
      font-size: 12px;
    }
    #tavern-roamer-panel.tr-floating .text_pole {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid var(--SmartThemeBorderColor, color-mix(in srgb, currentColor 20%, transparent));
      padding: 6px 8px;
      background: color-mix(in srgb, canvas 96%, currentColor 4%);
      color: inherit;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label input {
      width: auto;
    }
  `;
    hostDocument.head.append(style);
}
function statusIcon(status) {
    if (status === 'pass')
        return 'PASS';
    if (status === 'fail')
        return 'FAIL';
    return 'SKIP';
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => escapeMap[char] ?? char);
}
function escapeAttribute(value) {
    return escapeHtml(value);
}
const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

;// ./src/index.ts














registerPhase0SelfChecks();
registerApiSpikeSelfChecks();
registerChatSelfChecks();
const tavern = createTavernApi();
const auth = new GoogleIdentityAuth(() => loadSettings().googleClientId);
const driveClient = new GoogleDriveClient({ tokenProvider: auth });
const driveService = new DriveService(driveClient);
const adapter = tavern.getChatAdapter();
const chatSync = new ChatSyncService(adapter, driveService);
const environmentBackup = new EnvironmentBackupService(adapter, driveService);
const environmentRestore = new EnvironmentRestoreService(adapter, driveService);
let driveState = { connected: false, email: null, error: null };
registerDriveSelfChecks(driveService, () => driveState.connected);
const panel = createPanel({
    getContext: () => tavern.getContext(),
    getDriveState: () => driveState,
    onSave: settings => tavern.notify(`裝置名稱已儲存：${settings.deviceName}`, 'success'),
    onConnectDrive: async () => {
        await auth.connect();
        const email = await driveClient.getAccountEmail();
        driveState = { connected: true, email, error: null };
        await chatSync.flushQueue();
        await refreshPanelContext();
        return driveState;
    },
    onManualUpload: async () => {
        const result = await chatSync.uploadCurrentChat({ queueOnFail: true });
        await chatSync.flushQueue();
        await refreshPanelContext();
        tavern.notify(result.queued ? '上傳失敗，已加入待傳佇列' : '目前聊天已上傳', result.queued ? 'warning' : 'success');
        return result.filename;
    },
    onBackupEnvironment: async (items, onProgress) => {
        const results = await environmentBackup.backupItems(items, { onProgress });
        const done = results.filter(result => result.status === 'done');
        const failed = results.filter(result => result.status === 'error');
        tavern.notify(failed.length === 0 ? `環境備份完成，共 ${done.length} 項` : `環境備份 ${done.length} 項完成，${failed.length} 項失敗`, failed.length === 0 ? 'success' : 'warning');
        return results;
    },
    onRestoreEnvironment: async (items, onProgress) => {
        const result = await environmentRestore.restoreLatest(items, { onProgress });
        const done = result.items.filter(item => item.status === 'done');
        const failed = result.items.filter(item => item.status === 'error');
        const aborted = result.items.filter(item => item.status === 'aborted');
        const problems = failed.length + aborted.length;
        tavern.notify(problems === 0 ? `環境還原完成，共 ${done.length} 項` : `環境還原 ${done.length} 項完成，${problems} 項未套用`, problems === 0 ? 'success' : 'warning');
        return result;
    },
    onPreviewRestore: async (items) => {
        const preview = Object.fromEntries(ENVIRONMENT_ITEM_KINDS.map(kind => [kind, false]));
        for (const kind of items) {
            try {
                const versions = await environmentBackup.listItemVersions(kind);
                preview[kind] = versions.length > 0;
            }
            catch {
                preview[kind] = false;
            }
        }
        return preview;
    },
    onDownloadLatest: async () => {
        const filename = await chatSync.downloadLatestAndReplace();
        await refreshPanelContext();
        tavern.notify('已下載並覆蓋目前聊天', 'success');
        return filename;
    }
});
registerUiSelfChecks(() => panel.probe());
const autoSync = new AutoSyncController({
    upload: async () => {
        try {
            await chatSync.uploadCurrentChat({ queueOnFail: true });
            await refreshPanelContext();
        }
        catch (error) {
            tavern.notify(error instanceof Error ? error.message : String(error), 'warning');
        }
    }
});
async function refreshPanelContext() {
    const context = tavern.getContext();
    const pendingUploads = loadUploadQueue().length;
    try {
        const meta = tavern.getChatMeta();
        const remoteLatestFilename = driveState.connected && meta ? await chatSync.getLatestRemoteFilename(meta) : null;
        panel.updateContext({
            ...context,
            status: computeSyncStatus({
                connected: driveState.connected,
                meta,
                remoteLatestFilename,
                localMessageCount: context.lastMessageId === null ? 0 : context.lastMessageId + 1
            })
        }, { lastSyncedVersion: meta?.last_synced_version ?? null, pendingUploads });
    }
    catch {
        panel.updateContext(context, { lastSyncedVersion: null, pendingUploads });
    }
}
function boot() {
    globalThis.__tavernRoamerBooted = true;
    console.info('[TavernRoamer] booting panel');
    panel.mount();
    void auth.preload().catch(() => undefined);
    void refreshPanelContext();
    panel.updateDriveStatus(driveState);
    tavern.onChatChanged(chatFileName => {
        tavern.getContext(chatFileName);
        void refreshPanelContext();
    });
    tavern.onMessageCompleted(() => autoSync.handleMessageCompleted());
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
}
else {
    boot();
}


//# sourceMappingURL=tavern-roamer.js.map
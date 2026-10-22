
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
        // Google requires requestAccessToken to run directly from the user's click.
        // A network await here consumes that transient activation and browsers may
        // block the OAuth popup, so keep the header check diagnostic-only.
        void assertOAuthPopupAllowed(this.oauthHost).catch(error => {
            debugWarn('env:oauthCompatibilityBlocked', errorToLog(error));
        });
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
        const request = this.pendingRequest;
        try {
            return await request;
        }
        finally {
            if (this.pendingRequest === request) {
                this.pendingRequest = null;
            }
        }
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

;// ./src/appearance.ts
const defaultAppearance = {
    mode: 'tavern',
    accentColor: null,
    tone: 'standard'
};
function normalizeAppearance(value) {
    const candidate = typeof value === 'object' && value !== null
        ? value
        : {};
    return {
        mode: candidate.mode === 'light' || candidate.mode === 'dark' ? candidate.mode : 'tavern',
        accentColor: typeof candidate.accentColor === 'string' && /^#[\da-f]{6}$/i.test(candidate.accentColor)
            ? candidate.accentColor.toLowerCase()
            : null,
        tone: candidate.tone === 'soft' || candidate.tone === 'vivid' ? candidate.tone : 'standard'
    };
}

;// ./src/settings.ts


const defaultSettings = {
    appearance: { ...defaultAppearance },
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
        appearance: normalizeAppearance(candidate.appearance),
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
    pending = new Map();
    setTimeoutImpl;
    clearTimeoutImpl;
    debounceMs;
    constructor(options) {
        this.options = options;
        this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
        this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
        this.debounceMs = options.debounceMs ?? 10_000;
    }
    handleMessageCompleted(target) {
        const settings = loadSettings();
        if (!settings.autoSyncEnabled) {
            return;
        }
        const pending = this.pending.get(target.key) ?? { target, messageCount: 0, timer: null };
        pending.target = target;
        pending.messageCount += 1;
        this.pending.set(target.key, pending);
        if (pending.messageCount < settings.autoSyncEveryN) {
            return;
        }
        pending.messageCount = 0;
        this.schedule(pending);
    }
    stop() {
        for (const pending of this.pending.values()) {
            if (pending.timer)
                this.clearTimeoutImpl(pending.timer);
        }
        this.pending.clear();
    }
    schedule(pending) {
        if (pending.timer) {
            this.clearTimeoutImpl(pending.timer);
        }
        pending.timer = this.setTimeoutImpl(() => {
            pending.timer = null;
            const target = pending.target;
            if (pending.messageCount === 0)
                this.pending.delete(target.key);
            if (!loadSettings().autoSyncEnabled)
                return;
            void this.options.upload(target);
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
    const createdAt = parseDriveDate(item.createdAt);
    const updatedAt = parseDriveDate(item.updatedAt);
    return {
        ...parsed,
        fileId: item.id,
        filename: item.name,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {})
    };
}
function sortVersions(versions) {
    return [...versions].sort((left, right) => {
        const timeOrder = versionOrderTime(left) - versionOrderTime(right);
        if (timeOrder !== 0)
            return timeOrder;
        const filenameOrder = left.filename.localeCompare(right.filename);
        return filenameOrder !== 0 ? filenameOrder : left.fileId.localeCompare(right.fileId);
    });
}
function versionOrderTime(version) {
    return version.createdAt?.getTime() ?? version.uploadedAt.getTime();
}
function parseDriveDate(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
function formatLocalTime(date, locale = defaultLocale(), timeZone) {
    return formatLocalDateTime(date, locale, timeZone, true);
}
function formatLocalMinute(date, locale = defaultLocale(), timeZone) {
    return formatLocalDateTime(date, locale, timeZone, false);
}
function formatLocalDateTime(date, locale, timeZone, includeSeconds) {
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };
    if (includeSeconds) {
        options.second = '2-digit';
    }
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

;// ./src/chat/ChatOperationCoordinator.ts
class ChatOperationCoordinator {
    tails = new Map();
    run(key, operation) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const tail = result.then(() => undefined, () => undefined);
        this.tails.set(key, tail);
        void tail.finally(() => {
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        });
        return result;
    }
}

;// ./src/chat/context.ts
function chatRefKey(ref) {
    return JSON.stringify([ref.avatarUrl, ref.nativeChatId]);
}
function sameChatRef(left, right) {
    return left.nativeChatId === right.nativeChatId && left.avatarUrl === right.avatarUrl;
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
function updateLastSyncedVersion(store, meta, filename, messageCount, content) {
    const next = {
        ...meta,
        last_synced_version: filename,
        last_synced_message_count: messageCount,
        ...(content ? {
            last_synced_content_hash: content.hash,
            last_synced_hash_version: content.version
        } : {})
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
/**
 * 拉取聊天時的本地檔名。檔名尾端帶雲端 chat_id，
 * 使 deriveChatId(檔名) === chat_id，保證後續同步指回同一雲端資料夾。
 */
function buildPulledChatFileName(characterName, chatId) {
    return `${characterName} - ${chatId}`;
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
    if (typeof metadata.device !== 'string' ||
        !Number.isInteger(metadata.message_count) ||
        typeof metadata.packed_at !== 'string' ||
        Number.isNaN(Date.parse(metadata.packed_at))) {
        throw new Error('聊天包 metadata 格式不完整');
    }
    if (!package_isRecord(parsed.chat_variables)) {
        throw new Error('聊天包 chat_variables 不是物件');
    }
    if (parsed.chat_worldbook !== null && typeof parsed.chat_worldbook !== 'string') {
        throw new Error('聊天包 chat_worldbook 格式錯誤');
    }
    if (!Array.isArray(parsed.messages)) {
        throw new Error('聊天包 messages 不是陣列');
    }
    if (!parsed.messages.every(message => package_isRecord(message) && Number.isInteger(message.message_id))) {
        throw new Error('聊天包 messages 含有無效樓層');
    }
    if (metadata.message_count !== parsed.messages.length) {
        throw new Error('聊天包 message_count 與 messages 數量不一致');
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
function countQueuedUploadsForChat(meta) {
    if (!meta)
        return 0;
    return loadUploadQueue().filter(item => {
        if (item.meta) {
            return item.meta.chat_id === meta.chat_id && item.meta.role_key === meta.role_key;
        }
        const path = item.path;
        return path.length >= 4
            && path[path.length - 1] === 'chat'
            && path[path.length - 2] === meta.chat_id
            && path[path.length - 3] === meta.role_key;
    }).length;
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
    return next;
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
function markQueuedUploadVerified(id, remoteFileId) {
    const updated = loadUploadQueue().map(item => item.id === id ? { ...item, status: 'remote_verified', remoteFileId } : item);
    saveUploadQueue(updated);
    return updated;
}
function setQueuedUploadRemoteId(id, remoteFileId) {
    let matched = null;
    const updated = loadUploadQueue().map(item => {
        if (item.id !== id)
            return item;
        matched = { ...item, remoteFileId };
        return matched;
    });
    if (!matched) {
        throw new Error('待傳工作不存在，無法保存遠端檔案 ID');
    }
    saveUploadQueue(updated);
    return matched;
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
        typeof item.attempts === 'number' &&
        (item.contentHash === undefined || typeof item.contentHash === 'string') &&
        (item.hashVersion === undefined || typeof item.hashVersion === 'number') &&
        (item.status === undefined || item.status === 'pending_upload' || item.status === 'remote_verified'));
}

;// ./src/chat/receipts.ts

const RECEIPTS_KEY = 'chat_sync_receipts';
function loadSyncReceipts() {
    const value = readScriptVariable(RECEIPTS_KEY);
    return Array.isArray(value) ? value.filter(isReceipt) : [];
}
function saveSyncReceipt(receipt) {
    const receipts = loadSyncReceipts().filter(item => item.id !== receipt.id);
    writeScriptVariable(RECEIPTS_KEY, [...receipts, receipt]);
}
function removeSyncReceipt(id) {
    writeScriptVariable(RECEIPTS_KEY, loadSyncReceipts().filter(item => item.id !== id));
}
function markSyncReceiptSuperseded(id) {
    writeScriptVariable(RECEIPTS_KEY, loadSyncReceipts().map(receipt => receipt.id === id ? { ...receipt, status: 'superseded' } : receipt));
}
function isReceipt(value) {
    if (!value || typeof value !== 'object')
        return false;
    const item = value;
    const ref = item.ref;
    const meta = item.meta;
    return (typeof item.id === 'string' &&
        typeof item.filename === 'string' &&
        typeof item.messageCount === 'number' &&
        (item.contentHash === undefined || typeof item.contentHash === 'string') &&
        (item.hashVersion === undefined || typeof item.hashVersion === 'number') &&
        (item.status === undefined || item.status === 'pending' || item.status === 'superseded') &&
        typeof item.createdAt === 'string' &&
        !!ref &&
        typeof ref.nativeChatId === 'string' &&
        typeof ref.rawFileName === 'string' &&
        typeof ref.displayFileName === 'string' &&
        typeof ref.avatarUrl === 'string' &&
        !!meta &&
        typeof meta.chat_id === 'string' &&
        typeof meta.role_key === 'string');
}

;// ./src/chat/retentionQueue.ts

const RETENTION_QUEUE_KEY = 'chat_retention_queue';
function loadRetentionQueue() {
    const value = readScriptVariable(RETENTION_QUEUE_KEY);
    return Array.isArray(value) ? value.filter(isRetentionTask) : [];
}
function enqueueRetention(path, error) {
    const key = JSON.stringify(path);
    const queue = loadRetentionQueue();
    const existing = queue.find(item => item.key === key);
    const task = {
        key,
        path: [...path],
        attempts: (existing?.attempts ?? 0) + 1
    };
    const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    if (message)
        task.lastError = message;
    writeScriptVariable(RETENTION_QUEUE_KEY, [...queue.filter(item => item.key !== key), task]);
}
function removeRetention(key) {
    writeScriptVariable(RETENTION_QUEUE_KEY, loadRetentionQueue().filter(item => item.key !== key));
}
function isRetentionTask(value) {
    if (!value || typeof value !== 'object')
        return false;
    const item = value;
    return (typeof item.key === 'string' &&
        Array.isArray(item.path) &&
        item.path.every(segment => typeof segment === 'string') &&
        typeof item.attempts === 'number');
}

;// ./src/chat/snapshot.ts
const CHAT_CONTENT_HASH_VERSION = 1;
async function createChatContentSnapshot(content) {
    const parsed = parseRawChatContent(content);
    const canonicalContent = parsed.rows.map(row => stableStringify(stripSyncBookkeeping(row))).join('\n');
    const contentHash = await sha256(canonicalContent);
    return {
        canonicalContent,
        contentHash,
        hashVersion: CHAT_CONTENT_HASH_VERSION,
        messageCount: parsed.messageCount
    };
}
function parseRawChatContent(content) {
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('聊天 JSONL 為空或不是字串');
    }
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    const rows = lines.map((line, index) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error(`聊天 JSONL 第 ${index + 1} 行無法解析`);
        }
        if (!snapshot_isRecord(parsed))
            throw new Error(`聊天 JSONL 第 ${index + 1} 行必須是物件`);
        return parsed;
    });
    const header = rows[0];
    if (!header || !isHeader(header))
        throw new Error('聊天 JSONL 缺少合法 header');
    for (let index = 1; index < rows.length; index += 1) {
        if (!isMessage(rows[index]))
            throw new Error(`聊天 JSONL 第 ${index + 1} 行不是支援的訊息物件`);
    }
    return { rows, messageCount: Math.max(0, rows.length - 1) };
}
function isHeader(row) {
    return row.chat_metadata !== undefined || typeof row.user_name === 'string' || typeof row.name === 'string';
}
function isMessage(row) {
    return (typeof row.mes === 'string' ||
        typeof row.message === 'string' ||
        typeof row.name === 'string' ||
        row.is_user === true ||
        row.is_system === true ||
        row.role === 'user' ||
        row.role === 'assistant' ||
        row.role === 'system');
}
function stripSyncBookkeeping(row) {
    const cloned = cloneJson(row);
    delete cloned._drive_sync;
    for (const container of [cloned.variables, cloned.chat_variables])
        removeSyncKey(container);
    if (snapshot_isRecord(cloned.chat_metadata)) {
        delete cloned.chat_metadata._drive_sync;
        removeSyncKey(cloned.chat_metadata.variables);
        removeSyncKey(cloned.chat_metadata.chat_variables);
    }
    return cloned;
}
function removeSyncKey(value) {
    if (snapshot_isRecord(value))
        delete value._drive_sync;
}
function cloneJson(value) {
    if (Array.isArray(value))
        return value.map(cloneJson);
    if (!snapshot_isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
}
function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    if (snapshot_isRecord(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
async function sha256(value) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
        throw new Error('目前環境不支援 SHA-256，無法安全核對聊天內容');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function snapshot_isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

;// ./src/contextRevision.ts
let contextRevision = 0;
/**
 * Monotonic revision for host chat/character navigation. A ref alone cannot
 * distinguish staying on A from switching A -> B -> A during an async job.
 */
function getContextRevision() {
    return contextRevision;
}
function markContextChanged() {
    contextRevision += 1;
    return contextRevision;
}

;// ./src/chat/ChatSyncService.ts
/* unused harmony import specifier */ var ChatSyncService_parseRawChatContent;












const RAW_CHAT_MIME = 'application/x-ndjson; charset=UTF-8';
class ChatSyncService {
    tavern;
    drive;
    coordinator = new ChatOperationCoordinator();
    flushPromise = null;
    constructor(tavern, drive) {
        this.tavern = tavern;
        this.drive = drive;
    }
    ensureSyncMeta() {
        return ensureSyncMeta(this.tavern, loadSettings().deviceName);
    }
    captureCurrentChat() {
        const contextRevision = getContextRevision();
        const ref = this.currentChatRef();
        const meta = this.ensureSyncMeta();
        if (!this.isCurrent(ref, contextRevision)) {
            throw new Error('聊天已切換，請在目標聊天重新操作');
        }
        return {
            operationId: createOperationId(),
            key: chatRefKey(ref),
            ref,
            meta,
            contextRevision
        };
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
    uploadCurrentChat(options = {}) {
        return this.uploadChat(this.captureCurrentChat(), options);
    }
    uploadChat(target, options = {}) {
        return this.coordinator.run(target.key, () => this.performUpload(target, options));
    }
    assertTargetCurrent(target) {
        this.assertCurrent(target.ref, target.contextRevision);
    }
    flushQueue() {
        if (this.flushPromise) {
            return this.flushPromise;
        }
        const running = this.performFlushQueue();
        this.flushPromise = running;
        void running.then(() => {
            if (this.flushPromise === running) {
                this.flushPromise = null;
            }
        }, () => {
            if (this.flushPromise === running) {
                this.flushPromise = null;
            }
        });
        return running;
    }
    downloadLatestAndReplace() {
        const target = this.captureCurrentChat();
        return this.coordinator.run(target.key, () => this.performDownloadLatestAndReplace(target));
    }
    async getLatestRemoteFilename(meta = this.ensureSyncMeta()) {
        return (await this.getRemoteVersionState(meta)).latestFilename;
    }
    async getRemoteVersionState(meta = this.ensureSyncMeta()) {
        const versions = (await this.drive.listVersions(driveChatPath(meta)))
            .filter(version => version.filename.endsWith('.jsonl'));
        return {
            latestFilename: versions.at(-1)?.filename ?? null,
            baselineFound: Boolean(meta.last_synced_version && versions.some(version => version.filename === meta.last_synced_version))
        };
    }
    async getCurrentContentHash() {
        const contextRevision = getContextRevision();
        const ref = this.currentChatRef();
        const raw = await this.tavern.exportRawChat(ref);
        this.assertCurrent(ref, contextRevision);
        return (await createChatContentSnapshot(raw.content)).contentHash;
    }
    async applyPendingReceiptsForCurrent() {
        let applied = 0;
        for (const receipt of loadSyncReceipts()) {
            if (!this.isCurrent(receipt.ref) || receipt.status === 'superseded') {
                continue;
            }
            try {
                const contextRevision = getContextRevision();
                if (!receipt.contentHash || !receipt.hashVersion) {
                    markSyncReceiptSuperseded(receipt.id);
                    continue;
                }
                const local = await createChatContentSnapshot((await this.tavern.exportRawChat(receipt.ref)).content);
                if (local.contentHash !== receipt.contentHash || local.hashVersion !== receipt.hashVersion) {
                    markSyncReceiptSuperseded(receipt.id);
                    continue;
                }
                this.assertCurrent(receipt.ref, contextRevision);
                const current = this.ensureSyncMeta();
                if (!current.last_synced_version || current.last_synced_version <= receipt.filename) {
                    updateLastSyncedVersion(this.tavern, current, receipt.filename, receipt.messageCount, {
                        hash: receipt.contentHash,
                        version: receipt.hashVersion
                    });
                }
                removeSyncReceipt(receipt.id);
                applied += 1;
            }
            catch {
                // 保留 receipt，下次切回此聊天或重新載入時再試。
            }
        }
        return applied;
    }
    async performUpload(target, options) {
        const rawChat = await this.tavern.exportRawChat(target.ref);
        const snapshot = await createChatContentSnapshot(rawChat.content);
        const filename = buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl');
        const path = driveChatPath(target.meta);
        const job = enqueueUpload({
            operationId: target.operationId,
            status: 'pending_upload',
            path,
            filename,
            package: rawChat.content,
            mimeType: RAW_CHAT_MIME,
            ref: target.ref,
            meta: target.meta,
            messageCount: snapshot.messageCount,
            contentHash: snapshot.contentHash,
            hashVersion: snapshot.hashVersion
        });
        try {
            const folderId = await this.drive.ensureFolderPath(path);
            const remoteFileId = await this.uploadQueuedPayload(job, folderId);
            markQueuedUploadVerified(job.id, remoteFileId);
        }
        catch (error) {
            if (!options.queueOnFail) {
                removeQueuedUpload(job.id);
                throw error;
            }
            incrementQueuedUpload(job.id);
            return {
                operationId: target.operationId,
                meta: target.meta,
                filename,
                path,
                queued: true,
                metadata: 'deferred',
                cleanup: 'skipped'
            };
        }
        const metadata = await this.finalizeSync(target.operationId, target.ref, target.meta, filename, snapshot, target.contextRevision);
        if (metadata !== 'failed') {
            removeQueuedUpload(job.id);
        }
        const cleanup = await this.cleanupAfterUpload(path);
        return {
            operationId: target.operationId,
            meta: { ...target.meta, last_synced_version: filename },
            filename,
            path,
            queued: false,
            metadata,
            cleanup
        };
    }
    async performFlushQueue() {
        let uploaded = 0;
        for (const item of loadUploadQueue()) {
            const key = item.ref ? chatRefKey(item.ref) : JSON.stringify(item.path);
            const completed = await this.coordinator.run(key, () => this.flushItem(item));
            if (completed) {
                uploaded += 1;
            }
        }
        await this.retryRetentionQueue();
        return { uploaded, remaining: loadUploadQueue().length };
    }
    async flushItem(item) {
        try {
            if (item.status !== 'remote_verified') {
                const folderId = await this.drive.ensureFolderPath(item.path);
                const remoteFileId = await this.uploadQueuedPayload(item, folderId);
                markQueuedUploadVerified(item.id, remoteFileId);
            }
        }
        catch {
            incrementQueuedUpload(item.id);
            return false;
        }
        let metadata = null;
        if (item.ref && item.meta && typeof item.messageCount === 'number') {
            metadata = await this.finalizeSync(item.operationId ?? item.id, item.ref, item.meta, item.filename, {
                messageCount: item.messageCount,
                ...(item.contentHash ? { contentHash: item.contentHash } : {}),
                ...(item.hashVersion ? { hashVersion: item.hashVersion } : {})
            });
        }
        if (metadata !== 'failed') {
            removeQueuedUpload(item.id);
        }
        await this.cleanupAfterUpload(item.path);
        return true;
    }
    async uploadQueuedPayload(item, folderId) {
        let remoteFileId = item.remoteFileId;
        if (!remoteFileId) {
            remoteFileId = await this.drive.generateFileId();
            setQueuedUploadRemoteId(item.id, remoteFileId);
        }
        try {
            const result = typeof item.package === 'string'
                ? await this.drive.uploadText(folderId, item.filename, item.package, item.mimeType, remoteFileId)
                : await this.drive.uploadJson(folderId, item.filename, item.package, remoteFileId);
            return result.id;
        }
        catch (error) {
            if (!(error instanceof DriveError) || error.status !== 409) {
                throw error;
            }
            const existing = await this.drive.getFile(remoteFileId);
            if (!existing || existing.name !== item.filename || existing.parentId !== folderId) {
                throw new DriveError('既有 Drive 檔案與待傳工作不符', 409, 'upload_identity_mismatch');
            }
            return existing.id;
        }
    }
    async performDownloadLatestAndReplace(target) {
        this.assertCurrent(target.ref, target.contextRevision);
        const initialLocal = await this.tavern.exportRawChat(target.ref);
        const initialSnapshot = await createChatContentSnapshot(initialLocal.content);
        this.assertCurrent(target.ref, target.contextRevision);
        const path = driveChatPath(target.meta);
        const versions = await this.drive.listVersions(path);
        const latest = latestRawChatVersion(versions);
        if (!latest) {
            throw new Error('雲端沒有可下載的聊天版本');
        }
        const rawContent = latest.filename.endsWith('.jsonl')
            ? await this.drive.downloadText(latest.fileId)
            : null;
        if (rawContent === null) {
            unpackChatPackage(await this.drive.downloadJson(latest.fileId));
            throw new Error('舊版 .json 聊天包目前無法安全保存至指定聊天，更新未套用');
        }
        const remoteSnapshot = await createChatContentSnapshot(rawContent);
        this.assertCurrent(target.ref, target.contextRevision);
        const localBeforeRestore = await this.tavern.exportRawChat(target.ref);
        await this.assertUnchanged(initialSnapshot, localBeforeRestore.content);
        this.assertCurrent(target.ref, target.contextRevision);
        await this.uploadPreRestore(target.meta, localBeforeRestore);
        this.assertCurrent(target.ref, target.contextRevision);
        await this.assertUnchanged(initialSnapshot, (await this.tavern.exportRawChat(target.ref)).content);
        this.assertCurrent(target.ref, target.contextRevision);
        await this.tavern.replaceRawChat(rawContent, target.ref);
        // replaceRawChat 會重新載入目前聊天，宿主因此可能送出 CHAT_CHANGED 並
        // 推進 context revision。這是同一聊天完成覆寫後的正常 reload，不應再用
        // 操作開始前的 revision 否決同步紀錄；finalizeSync 仍會以目前 ref、內容
        // hash 與它在呼叫當下取得的新 revision 防止寫入其他聊天。
        let metadata = await this.finalizeSync(target.operationId, target.ref, target.meta, latest.filename, remoteSnapshot);
        if (metadata === 'deferred' && this.isCurrent(target.ref)) {
            await this.applyPendingReceiptsForCurrent();
            const current = this.ensureSyncMeta();
            if (current.last_synced_version === latest.filename
                && current.last_synced_content_hash === remoteSnapshot.contentHash
                && current.last_synced_hash_version === remoteSnapshot.hashVersion) {
                metadata = 'applied';
            }
        }
        return {
            filename: latest.filename,
            metadata,
            status: metadata === 'applied' ? 'done' : 'partial'
        };
    }
    async finalizeSync(operationId, ref, meta, filename, snapshot, expectedContextRevision = getContextRevision()) {
        if (this.isCurrent(ref, expectedContextRevision)) {
            try {
                if (!snapshot.contentHash || !snapshot.hashVersion) {
                    this.saveReceipt(operationId, ref, meta, filename, snapshot, 'superseded');
                    return 'deferred';
                }
                const local = await createChatContentSnapshot((await this.tavern.exportRawChat(ref)).content);
                if (local.contentHash !== snapshot.contentHash || local.hashVersion !== snapshot.hashVersion) {
                    this.saveReceipt(operationId, ref, meta, filename, snapshot, 'superseded');
                    return 'deferred';
                }
                this.assertCurrent(ref, expectedContextRevision);
                const current = this.ensureSyncMeta();
                if (!current.last_synced_version || current.last_synced_version <= filename) {
                    updateLastSyncedVersion(this.tavern, current, filename, snapshot.messageCount, {
                        hash: snapshot.contentHash,
                        version: snapshot.hashVersion
                    });
                }
                return 'applied';
            }
            catch {
                if (!this.isCurrent(ref, expectedContextRevision)) {
                    try {
                        this.saveReceipt(operationId, ref, meta, filename, snapshot, 'pending');
                        return 'deferred';
                    }
                    catch {
                        return 'failed';
                    }
                }
                return 'failed';
            }
        }
        try {
            this.saveReceipt(operationId, ref, meta, filename, snapshot, 'pending');
            return 'deferred';
        }
        catch {
            return 'failed';
        }
    }
    saveReceipt(operationId, ref, meta, filename, snapshot, status) {
        saveSyncReceipt({
            id: operationId,
            ref,
            meta,
            filename,
            messageCount: snapshot.messageCount,
            createdAt: new Date().toISOString(),
            status,
            ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
            ...(snapshot.hashVersion ? { hashVersion: snapshot.hashVersion } : {})
        });
    }
    async assertUnchanged(expected, currentContent) {
        const current = await createChatContentSnapshot(currentContent);
        if (current.contentHash !== expected.contentHash || current.hashVersion !== expected.hashVersion) {
            throw new Error('等待更新期間本地聊天內容已變更，更新未套用');
        }
    }
    async uploadPreRestore(meta, rawChat) {
        const folderId = await this.drive.ensureFolderPath([
            'SillyTavernSync',
            meta.role_key,
            meta.chat_id,
            '_pre_restore',
            new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
        ]);
        await this.drive.uploadText(folderId, buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl'), rawChat.content, RAW_CHAT_MIME);
    }
    async cleanupAfterUpload(path) {
        if (loadSettings().chatRetention.mode !== 'keep_latest_n') {
            return 'skipped';
        }
        try {
            await this.cleanupOldVersions(path);
            return 'done';
        }
        catch (error) {
            enqueueRetention(path, error);
            return 'pending';
        }
    }
    async retryRetentionQueue() {
        for (const task of loadRetentionQueue()) {
            try {
                await this.cleanupOldVersions(task.path);
                removeRetention(task.key);
            }
            catch (error) {
                enqueueRetention(task.path, error);
            }
        }
    }
    async cleanupOldVersions(path) {
        const settings = loadSettings();
        if (settings.chatRetention.mode !== 'keep_latest_n') {
            return;
        }
        const versions = await this.drive.listVersions(path);
        const stale = versions.slice(0, Math.max(0, versions.length - settings.chatRetention.latestN));
        await Promise.all(stale.map(version => this.drive.deleteFile(version.fileId)));
    }
    currentChatRef() {
        if (this.tavern.getCurrentChatRef) {
            return this.tavern.getCurrentChatRef();
        }
        const displayFileName = this.tavern.getCurrentChatFileName() ?? '';
        return {
            nativeChatId: displayFileName.replace(/\.jsonl?$/i, ''),
            rawFileName: displayFileName.endsWith('.jsonl') ? displayFileName : `${displayFileName}.jsonl`,
            displayFileName,
            avatarUrl: this.tavern.getCurrentCharacterName() ?? ''
        };
    }
    isCurrent(ref, contextRevision) {
        if (contextRevision !== undefined && contextRevision !== getContextRevision())
            return false;
        return this.tavern.isCurrentChat
            ? this.tavern.isCurrentChat(ref)
            : sameChatRef(this.currentChatRef(), ref);
    }
    assertCurrent(ref, contextRevision) {
        if (!this.isCurrent(ref, contextRevision)) {
            throw new Error('聊天已切換，已中止更新以避免覆蓋其他聊天');
        }
    }
}
function driveChatPath(meta) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, 'chat'];
}
function countJsonlMessages(content) {
    return ChatSyncService_parseRawChatContent(content).messageCount;
}
function latestRawChatVersion(versions) {
    return [...versions].reverse().find(version => version.filename.toLowerCase().endsWith('.jsonl')) ?? null;
}
function createOperationId() {
    return globalThis.crypto?.randomUUID?.() ?? `sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

;// ./src/environment/validation.ts
class SnapshotValidationError extends Error {
    path;
    code;
    constructor(code, path, message) {
        super(`${message}（${path}）`);
        this.path = path;
        this.name = 'SnapshotValidationError';
        this.code = code;
    }
}
function parseEnvironmentSnapshot(expectedKind, value) {
    const root = expectRecord(value, '$');
    if (root.kind !== expectedKind) {
        invalid('$.kind', `環境備份類型應為 ${expectedKind}`);
    }
    validateSchemaVersion(root.schemaVersion);
    validateExportedAt(root.exportedAt);
    let snapshot;
    if (expectedKind === 'character')
        snapshot = parseCharacter(root);
    else if (expectedKind === 'world')
        snapshot = parseWorld(root);
    else if (expectedKind === 'persona')
        snapshot = parsePersona(root);
    else if (expectedKind === 'preset')
        snapshot = parsePreset(root);
    else
        snapshot = parseRegex(root);
    return snapshot;
}
function parseCharacter(root) {
    const data = expectRecord(root.data, '$.data');
    const characterName = readName(root.characterName) ?? readName(data.name);
    if (!characterName)
        invalid('$.characterName', '角色卡備份缺少可辨識的角色名稱');
    validateAvatarImage(root.avatarImage, '角色卡');
    return { ...root, schemaVersion: 1, kind: 'character', exportedAt: root.exportedAt, characterName, data };
}
function parsePersona(root) {
    const data = expectRecord(root.data, '$.data');
    const name = readName(root.name) ?? readName(data.name);
    if (!name)
        invalid('$.name', 'Persona 備份缺少可辨識的名稱');
    validateAvatarImage(root.avatarImage, 'Persona');
    return { ...root, schemaVersion: 1, kind: 'persona', exportedAt: root.exportedAt, name, data };
}
function validateAvatarImage(value, subject) {
    if (value === undefined)
        return;
    const image = expectRecord(value, '$.avatarImage');
    if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) {
        invalid('$.avatarImage.mimeType', `${subject} 頭像類型不是圖片`);
    }
    if (typeof image.base64 !== 'string' || !image.base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
        invalid('$.avatarImage.base64', `${subject} 頭像內容不是有效的 Base64`);
    }
}
function parseWorld(root) {
    const bindings = parseBindings(root.bindings);
    const books = expectRecord(root.books, '$.books');
    const format = parseWorldFormat(root.format, books);
    for (const [name, book] of Object.entries(books)) {
        if (!name.trim())
            invalid('$.books', '世界書名稱不可為空');
        if (format === 'sillytavern-worldinfo-v1')
            validateRawWorldbook(book, `$.books.${name}`);
        else
            validateHelperWorldbook(book, `$.books.${name}`);
    }
    for (const name of [bindings.chat, bindings.char_primary, ...bindings.char_additional, ...bindings.global_enabled]) {
        if (name && !Object.hasOwn(books, name))
            invalid('$.books', `世界書綁定「${name}」缺少對應內容`);
    }
    return {
        ...root,
        schemaVersion: 1,
        kind: 'world',
        exportedAt: root.exportedAt,
        format,
        bindings,
        books
    };
}
function parsePreset(root) {
    const name = readName(root.name);
    if (!name)
        invalid('$.name', 'Preset 備份缺少名稱');
    const data = expectRecord(root.data, '$.data');
    const format = parsePresetFormat(root.format, data);
    if (format === 'sillytavern-openai-preset-v1') {
        expectArray(data.prompts, '$.data.prompts').forEach((item, index) => expectRecord(item, `$.data.prompts[${index}]`));
        expectArray(data.prompt_order, '$.data.prompt_order').forEach((item, index) => expectRecord(item, `$.data.prompt_order[${index}]`));
        expectRecord(data.extensions, '$.data.extensions');
    }
    else if (format === 'tavern-helper-preset-v1') {
        expectRecord(data.settings, '$.data.settings');
        expectArray(data.prompts, '$.data.prompts').forEach((item, index) => expectRecord(item, `$.data.prompts[${index}]`));
        expectArray(data.prompts_unused, '$.data.prompts_unused').forEach((item, index) => expectRecord(item, `$.data.prompts_unused[${index}]`));
        expectRecord(data.extensions, '$.data.extensions');
    }
    return {
        ...root,
        schemaVersion: 1,
        kind: 'preset',
        exportedAt: root.exportedAt,
        format,
        name,
        data
    };
}
function parseRegex(root) {
    if (root.scope !== 'global')
        invalid('$.scope', 'Regex 備份 scope 必須為 global');
    const items = expectArray(root.items, '$.items');
    items.forEach((item, index) => validateRegexItem(item, `$.items[${index}]`));
    return {
        ...root,
        schemaVersion: 1,
        kind: 'regex',
        exportedAt: root.exportedAt,
        scope: 'global',
        items
    };
}
function validateSchemaVersion(version) {
    if (version === undefined || version === 1)
        return;
    throw new SnapshotValidationError('unsupported_schema_version', '$.schemaVersion', `不支援的環境備份版本：${String(version)}`);
}
function validateExportedAt(value) {
    if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
        invalid('$.exportedAt', '環境備份 exportedAt 不是有效日期時間');
    }
}
function parseBindings(value) {
    const bindings = expectRecord(value, '$.bindings');
    return {
        chat: readNullableString(bindings.chat, '$.bindings.chat'),
        char_primary: readNullableString(bindings.char_primary, '$.bindings.char_primary'),
        char_additional: readStringArray(bindings.char_additional, '$.bindings.char_additional'),
        global_enabled: readStringArray(bindings.global_enabled, '$.bindings.global_enabled')
    };
}
function parseWorldFormat(value, books) {
    if (value === 'sillytavern-worldinfo-v1' || value === 'tavern-helper-worldbook-v1')
        return value;
    if (value !== undefined)
        unsupportedFormat('$.format', value);
    const contents = Object.values(books);
    if (contents.every(Array.isArray))
        return 'tavern-helper-worldbook-v1';
    if (contents.every(book => validation_isRecord(book) && validation_isRecord(book.entries)))
        return 'sillytavern-worldinfo-v1';
    unsupportedFormat('$.format', value);
}
function parsePresetFormat(value, data) {
    if (value === 'sillytavern-openai-preset-v1' ||
        value === 'sillytavern-textgenerationwebui-preset-v1' ||
        value === 'tavern-helper-preset-v1')
        return value;
    if (value !== undefined)
        unsupportedFormat('$.format', value);
    if (validation_isRecord(data.settings) && Array.isArray(data.prompts) && Array.isArray(data.prompts_unused) && validation_isRecord(data.extensions)) {
        return 'tavern-helper-preset-v1';
    }
    return 'sillytavern-textgenerationwebui-preset-v1';
}
function validateRawWorldbook(value, path) {
    const book = expectRecord(value, path);
    const entries = expectRecord(book.entries, `${path}.entries`);
    for (const [key, entry] of Object.entries(entries))
        expectRecord(entry, `${path}.entries.${key}`);
}
function validateHelperWorldbook(value, path) {
    expectArray(value, path).forEach((entry, index) => expectRecord(entry, `${path}[${index}]`));
}
function validateRegexItem(value, path) {
    const item = expectRecord(value, path);
    const hasIdentity = [item.id, item.scriptName, item.name].some(entry => (typeof entry === 'string' && entry.trim().length > 0) || typeof entry === 'number');
    if (!hasIdentity)
        invalid(path, 'Regex 規則缺少 id、scriptName 或 name');
    for (const key of ['findRegex', 'replaceString', 'regex', 'replacement']) {
        if (item[key] !== undefined && typeof item[key] !== 'string')
            invalid(`${path}.${key}`, `Regex ${key} 必須是字串`);
    }
}
function readName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function readNullableString(value, path) {
    if (value === null)
        return null;
    if (typeof value !== 'string')
        invalid(path, '欄位必須為字串或 null');
    return value;
}
function readStringArray(value, path) {
    const items = expectArray(value, path);
    if (!items.every(item => typeof item === 'string'))
        invalid(path, '欄位必須是字串陣列');
    return items;
}
function expectRecord(value, path) {
    if (!validation_isRecord(value))
        invalid(path, '欄位必須是 JSON 物件');
    return value;
}
function expectArray(value, path) {
    if (!Array.isArray(value))
        invalid(path, '欄位必須是陣列');
    return value;
}
function validation_isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(path, message) {
    throw new SnapshotValidationError('invalid_snapshot', path, message);
}
function unsupportedFormat(path, value) {
    throw new SnapshotValidationError('unsupported_format', path, `不支援的備份格式：${String(value)}`);
}

;// ./src/chat/ChatPullService.ts






const ROOT_FOLDER = 'SillyTavernSync';
function chatFileMatchesChatId(fileName, chatId) {
    if (deriveChatId(fileName) === chatId) {
        return true;
    }
    const stem = fileName.replace(/\.[^.]+$/, '');
    return stem === chatId || stem.endsWith(` - ${chatId}`);
}
class ChatPullService {
    tavern;
    drive;
    constructor(tavern, drive) {
        this.tavern = tavern;
        this.drive = drive;
    }
    async pullChat(roleKey, chatId) {
        const operationContext = this.captureContext();
        const chatVersions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'chat']);
        const latest = [...chatVersions].reverse().find(version => version.filename.endsWith('.jsonl'));
        if (!latest) {
            throw new Error('這個聊天在雲端沒有可用來建立聊天的原始（.jsonl）版本');
        }
        const content = await this.drive.downloadText(latest.fileId);
        await createChatContentSnapshot(content);
        let character = this.findLocalCharacter(roleKey);
        let characterRestored = false;
        let pendingCharacter = null;
        if (!character) {
            const versions = await this.drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'character']);
            const characterVersion = versions.at(-1);
            if (!characterVersion) {
                throw new Error(`本地沒有角色卡「${roleKey}」，且雲端沒有這個聊天的角色卡備份。請先手動安裝角色卡，或在來源裝置執行「備份完整環境」。`);
            }
            pendingCharacter = parseEnvironmentSnapshot('character', await this.drive.downloadJson(characterVersion.fileId));
        }
        this.assertContextUnchanged(operationContext);
        if (pendingCharacter) {
            await this.tavern.applyCharacter(pendingCharacter);
            character = this.findLocalCharacter(roleKey, pendingCharacter.characterName ?? undefined);
            if (!character)
                throw new Error('角色卡還原後仍找不到唯一對應角色，請重新整理頁面後再試');
            characterRestored = true;
        }
        if (!character)
            throw new Error(`本地找不到角色卡：${roleKey}`);
        this.assertContextUnchanged(operationContext);
        await this.tavern.selectCharacter(character);
        this.assertCurrentCharacter(character);
        const selectedContextRevision = getContextRevision();
        const localChatFiles = await this.tavern.listCharacterChatFiles(character);
        this.assertContextRevision(selectedContextRevision, '查詢本地聊天期間畫面已切換，未建立雲端聊天');
        if (localChatFiles.some(fileName => chatFileMatchesChatId(fileName, chatId))) {
            throw new Error('本地已存在這個聊天（chat_id 相同）。請切到該聊天後改用「更新目前聊天」。');
        }
        const chatFileName = buildPulledChatFileName(character.name, chatId);
        this.assertCurrentCharacter(character);
        const filesBeforeSave = await this.tavern.listCharacterChatFiles(character);
        this.assertCurrentCharacter(character);
        this.assertContextRevision(selectedContextRevision, '建立聊天前畫面已切換，未建立雲端聊天');
        if (filesBeforeSave.some(fileName => chatFileMatchesChatId(fileName, chatId))) {
            throw new Error('建立前發現本地已存在這個聊天，未覆蓋既有檔案');
        }
        const chatBeforeSave = this.tavern.getCurrentChatFileName?.() ?? null;
        await this.tavern.createChatFile(character, chatFileName, content);
        this.assertCurrentCharacter(character);
        this.assertContextRevision(selectedContextRevision, '雲端聊天已建立，但操作期間畫面已切換；未自動開啟或寫入同步資訊');
        const chatAfterSave = this.tavern.getCurrentChatFileName?.() ?? null;
        if (chatAfterSave !== chatBeforeSave) {
            throw new Error('雲端聊天已建立，但操作期間目前聊天已切換；未自動開啟或寫入同步資訊');
        }
        await this.tavern.openChatFile(character, chatFileName);
        this.assertCurrentCharacter(character);
        const openedFileName = this.tavern.getCurrentChatFileName?.();
        if (!openedFileName || !chatFileMatchesChatId(openedFileName, chatId)) {
            throw new Error('聊天已切換，未寫入雲端聊天的同步資訊');
        }
        const localSnapshot = await createChatContentSnapshot((await this.tavern.exportRawChat()).content);
        const verifiedFileName = this.tavern.getCurrentChatFileName?.();
        if (!verifiedFileName || !chatFileMatchesChatId(verifiedFileName, chatId)) {
            throw new Error('核對聊天內容期間聊天已切換，未寫入雲端聊天的同步資訊');
        }
        // 身分與版本沿用雲端；內容基準使用酒館實際存回並重新匯出的結果，
        // 避免宿主正規化 JSONL 後立刻被誤判為本地修改。
        this.tavern.writeChatMeta({
            chat_id: chatId,
            role_key: roleKey,
            device_name: loadSettings().deviceName,
            last_synced_version: latest.filename,
            last_synced_message_count: localSnapshot.messageCount,
            last_synced_content_hash: localSnapshot.contentHash,
            last_synced_hash_version: localSnapshot.hashVersion
        });
        return { filename: latest.filename, chatFileName, characterRestored };
    }
    captureContext() {
        return {
            character: this.tavern.getCurrentCharacterRef(),
            chatFileName: this.tavern.getCurrentChatFileName?.() ?? null,
            contextRevision: getContextRevision()
        };
    }
    assertContextUnchanged(expected) {
        const current = this.captureContext();
        if (current.contextRevision !== expected.contextRevision ||
            current.character?.avatarUrl !== expected.character?.avatarUrl ||
            current.chatFileName !== expected.chatFileName) {
            throw new Error('操作期間角色或聊天已切換，未建立雲端聊天');
        }
    }
    assertContextRevision(expected, message) {
        if (getContextRevision() !== expected)
            throw new Error(message);
    }
    assertCurrentCharacter(expected) {
        if (this.tavern.getCurrentCharacterRef()?.avatarUrl !== expected.avatarUrl) {
            throw new Error('角色已切換，未繼續建立雲端聊天');
        }
    }
    findLocalCharacter(roleKey, preferredName) {
        const matches = this.tavern.listCharacters().filter(character => character.name === preferredName || character.name === roleKey || sanitizeRoleKey(character.name) === roleKey);
        if (matches.length > 1)
            throw new Error(`本地有多張角色卡符合「${roleKey}」，無法安全判定目標`);
        return matches[0] ?? null;
    }
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
        const contextKey = this.tavern.captureEnvironmentContext?.();
        // 同一批備份共用一個 UTC 時間戳（手冊第九章：時間戳同一批一致）
        const filename = buildVersionFilename(loadSettings().deviceName);
        const results = [];
        for (const kind of kinds) {
            let step = 'export';
            try {
                onProgress?.({ kind, step: 'export', state: 'start' });
                this.assertContext(contextKey);
                const snapshot = parseEnvironmentSnapshot(kind, await this.exportSnapshot(kind));
                this.assertContext(contextKey);
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
        return parseEnvironmentSnapshot(kind, downloaded);
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
    assertContext(contextKey) {
        if (contextKey && this.tavern.isEnvironmentContextCurrent && !this.tavern.isEnvironmentContextCurrent(contextKey)) {
            throw new Error('操作期間角色或聊天已切換，環境備份已中止');
        }
    }
}
function environmentItemPath(meta, kind) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

;// ./src/chat/ChatUploadReadinessService.ts



class ChatUploadReadinessService {
    drive;
    constructor(drive) {
        this.drive = drive;
    }
    async inspect(target) {
        const [chatVersions, ...environmentVersions] = await Promise.all([
            this.drive.listVersions(driveChatPath(target.meta)),
            ...ENVIRONMENT_ITEM_KINDS.map(kind => this.drive.listVersions(environmentItemPath(target.meta, kind)))
        ]);
        const latestChat = [...chatVersions].reverse().find(version => version.filename.endsWith('.jsonl')) ?? null;
        const environment = ENVIRONMENT_ITEM_KINDS.map((kind, index) => {
            const latest = environmentVersions[index]?.at(-1) ?? null;
            return {
                kind,
                available: Boolean(latest),
                latestFilename: latest?.filename ?? null
            };
        });
        const hasCharacter = environment.find(item => item.kind === 'character')?.available ?? false;
        return {
            target,
            isFirstUpload: !latestChat,
            latestChatFilename: latestChat?.filename ?? null,
            environment,
            recoveryStatus: !latestChat ? 'first_upload' : hasCharacter ? 'ready' : 'missing_character'
        };
    }
}

;// ./src/chat/ChatUploadWorkflow.ts
class ChatUploadWorkflow {
    chatSync;
    environmentBackup;
    readiness;
    preparations = new Map();
    constructor(chatSync, environmentBackup, readiness) {
        this.chatSync = chatSync;
        this.environmentBackup = environmentBackup;
        this.readiness = readiness;
    }
    async prepare() {
        this.preparations.clear();
        const target = this.chatSync.captureCurrentChat();
        const readiness = await this.readiness.inspect(target);
        this.chatSync.assertTargetCurrent(target);
        const preparation = {
            ...readiness,
            preparationId: createPreparationId()
        };
        this.preparations.set(preparation.preparationId, { preparation, running: false });
        return preparation;
    }
    invalidateAll() {
        this.preparations.clear();
    }
    async execute(request) {
        const stored = this.preparations.get(request.preparationId);
        if (!stored) {
            throw new Error('上傳確認已過期，請重新檢查目前聊天');
        }
        if (stored.running) {
            throw new Error('這次上傳已在執行中');
        }
        stored.running = true;
        try {
            const target = stored.preparation.target;
            this.chatSync.assertTargetCurrent(target);
            const latestReadiness = await this.readiness.inspect(target);
            this.chatSync.assertTargetCurrent(target);
            const selectedEnvironment = uniqueKinds(request.selectedEnvironment);
            const environmentResults = request.chatOnly || selectedEnvironment.length === 0
                ? []
                : await this.environmentBackup.backupItems(selectedEnvironment, {
                    meta: target.meta,
                    ...(request.onProgress ? { onProgress: request.onProgress } : {})
                });
            const existingCharacter = latestReadiness.environment.find(item => item.kind === 'character')?.available ?? false;
            const characterResult = environmentResults.find(item => item.kind === 'character');
            const characterAvailable = existingCharacter || characterResult?.status === 'done';
            if (!request.chatOnly && characterResult?.status === 'error' && !existingCharacter) {
                return {
                    status: 'aborted',
                    environmentResults,
                    chatResult: null,
                    recoveryStatus: 'missing_character'
                };
            }
            this.chatSync.assertTargetCurrent(target);
            const chatResult = await this.chatSync.uploadChat(target, { queueOnFail: true });
            const environmentFailed = environmentResults.some(result => result.status === 'error');
            const chatPartial = chatResult.cleanup === 'pending' || chatResult.metadata !== 'applied';
            return {
                status: chatResult.queued ? 'queued' : environmentFailed || chatPartial ? 'partial' : 'done',
                environmentResults,
                chatResult,
                recoveryStatus: characterAvailable ? 'ready' : 'missing_character'
            };
        }
        finally {
            this.preparations.delete(request.preparationId);
        }
    }
}
function uniqueKinds(kinds) {
    return [...new Set(kinds)];
}
function createPreparationId() {
    return globalThis.crypto?.randomUUID?.() ?? `upload_preparation_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

;// ./src/chat/browse.ts
const browse_ROOT_FOLDER = 'SillyTavernSync';
// 非聊天資料的功能性資料夾，瀏覽清單不列出
const EXCLUDED_FOLDERS = new Set(['_pre_restore', '_self_check']);
async function listCloudRoles(drive) {
    const folders = await drive.listChildFolders([browse_ROOT_FOLDER]);
    const names = [...new Set(folders.map(folder => folder.name))].filter(name => !EXCLUDED_FOLDERS.has(name));
    return names.map(roleKey => ({ roleKey }));
}
async function listCloudChats(drive, roleKey) {
    const folders = await drive.listChildFolders([browse_ROOT_FOLDER, roleKey]);
    const chatIds = [...new Set(folders.map(folder => folder.name))].filter(name => !EXCLUDED_FOLDERS.has(name));
    const entries = await Promise.all(chatIds.map(async (chatId) => {
        const versions = await drive.listVersions([browse_ROOT_FOLDER, roleKey, chatId, 'chat']);
        const rawVersions = versions.filter(version => version.filename.toLowerCase().endsWith('.jsonl'));
        return { chatId, versionCount: rawVersions.length, latest: rawVersions.at(-1) ?? null };
    }));
    // 最新更新的窗排前面；沒版本的排最後
    return entries.sort((left, right) => (right.latest?.filename ?? '').localeCompare(left.latest?.filename ?? ''));
}

;// ./src/chat/status.ts

function computeSyncStatus(input) {
    return deriveSyncStatus(deriveSyncFacts(input));
}
function deriveSyncFacts(input) {
    const baseline = input.meta?.last_synced_version ?? null;
    const connection = !input.connected
        ? 'disconnected'
        : input.remoteCheckFailed
            ? 'error'
            : 'ready';
    let local;
    if (!baseline) {
        local = 'untracked';
    }
    else if (input.localCheckFailed) {
        local = 'unknown';
    }
    else if (input.meta?.last_synced_content_hash) {
        local = input.meta.last_synced_hash_version !== (/* inlined export .CHAT_CONTENT_HASH_VERSION */1) || !input.localContentHash
            ? 'unknown'
            : input.localContentHash === input.meta.last_synced_content_hash
                ? 'clean'
                : 'dirty';
    }
    else if (typeof input.meta?.last_synced_message_count === 'number') {
        local = input.meta.last_synced_message_count === input.localMessageCount ? 'unknown' : 'dirty';
    }
    else {
        local = 'unknown';
    }
    let remote;
    if (!input.connected || input.remoteCheckFailed) {
        remote = 'unchecked';
    }
    else if (!input.remoteLatestFilename) {
        remote = 'missing';
    }
    else if (!baseline) {
        remote = 'exists_untracked';
    }
    else if (input.remoteLatestFilename === baseline) {
        remote = 'same';
    }
    else if (input.remoteBaselineFound === true) {
        remote = 'ahead';
    }
    else if (input.remoteBaselineFound === false) {
        remote = 'behind';
    }
    else {
        const order = input.remoteLatestFilename.localeCompare(baseline);
        remote = order > 0 ? 'ahead' : 'behind';
    }
    return {
        connection,
        local,
        remote,
        pendingUploads: Math.max(0, Math.floor(input.pendingUploads ?? 0))
    };
}
function deriveSyncStatus(facts) {
    if (facts.connection === 'disconnected')
        return 'not_connected';
    if (facts.connection === 'error')
        return 'check_failed';
    if (facts.local === 'untracked')
        return facts.remote === 'exists_untracked' ? 'remote_available' : 'untracked';
    if (facts.remote === 'missing')
        return 'remote_missing';
    if (facts.remote === 'behind')
        return 'remote_mismatch';
    if (facts.remote === 'ahead')
        return facts.local === 'dirty' ? 'conflict' : 'newer_remote';
    if (facts.remote !== 'same')
        return 'unknown';
    if (facts.local === 'clean')
        return 'synced';
    if (facts.local === 'dirty')
        return 'local_dirty';
    return 'unknown';
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
    async generateFileId() {
        const result = await this.requestJson(`${DRIVE_API}/files/generateIds?count=1&space=drive&type=files`);
        const id = result.ids?.[0];
        if (!id) {
            throw new DriveError('Drive did not return a generated file ID', 502, 'missing_generated_id');
        }
        return id;
    }
    async getFile(fileId) {
        try {
            const file = await this.requestJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,createdTime,modifiedTime,size`);
            return toDriveItem(file);
        }
        catch (error) {
            if (error instanceof DriveError && error.status === 404) {
                return null;
            }
            throw error;
        }
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
    async uploadJson(parentId, name, data, fileId) {
        const content = JSON.stringify(data, null, 2);
        return this.uploadText(parentId, name, content, 'application/json', fileId);
    }
    async uploadText(parentId, name, content, mimeType = 'text/plain; charset=UTF-8', fileId) {
        const size = new TextEncoder().encode(content).byteLength;
        if (size > RESUMABLE_THRESHOLD_BYTES) {
            return this.uploadResumable(parentId, name, content, mimeType, fileId);
        }
        return this.uploadMultipart(parentId, name, content, mimeType, fileId);
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
    async listFolders(parentId) {
        const query = [
            `mimeType = '${FOLDER_MIME}'`,
            'trashed = false',
            parentId ? `'${escapeDriveQueryString(parentId)}' in parents` : "'root' in parents"
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
    async trashFile(fileId) {
        await this.requestJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true })
        });
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
    async uploadMultipart(parentId, name, content, mimeType, fileId) {
        const boundary = `tavern_roamer_${Date.now().toString(36)}`;
        const metadata = {
            id: fileId,
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
    async uploadResumable(parentId, name, content, mimeType, fileId) {
        const bytes = new TextEncoder().encode(content);
        const session = await this.request(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,parents,createdTime,modifiedTime,size`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': String(bytes.byteLength)
            },
            body: JSON.stringify({ id: fileId, name, parents: [parentId], mimeType })
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
    if (typeof file.trashed === 'boolean') {
        item.trashed = file.trashed;
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
    generateFileId() {
        return this.client.generateFileId();
    }
    getFile(fileId) {
        return this.client.getFile(fileId);
    }
    async ensureFolderPath(path) {
        const normalized = normalizePath(path);
        const cacheKey = cacheKeyFor(normalized);
        const cache = loadFolderCache();
        let parentId = null;
        const resolvedPath = [];
        for (const segment of normalized) {
            resolvedPath.push(segment);
            const segmentKey = cacheKeyFor(resolvedPath);
            const cachedSegmentId = cache[segmentKey];
            const matchingFolders = await this.client.findFoldersByName(segment, parentId);
            const cachedFolder = cachedSegmentId
                ? matchingFolders.find(folder => folder.id === cachedSegmentId)
                : undefined;
            const folder = cachedFolder ?? matchingFolders[0] ?? (await this.ensureChildFolder(segment, parentId));
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
    async listChildFolders(path) {
        const parentIds = await this.resolveFolderPathAll(path);
        const folders = (await Promise.all(parentIds.map(parentId => this.client.listFolders(parentId)))).flat();
        const seen = new Map();
        for (const folder of folders) {
            if (!seen.has(folder.id)) {
                seen.set(folder.id, folder);
            }
        }
        return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
    }
    async listFilesInFolder(folderId) {
        return this.client.listFiles(folderId);
    }
    async listFoldersInFolder(folderId) {
        return this.client.listFolders(folderId);
    }
    async uploadJson(folderId, filename, content, fileId) {
        return this.client.uploadJson(folderId, filename, content, fileId);
    }
    async uploadText(folderId, filename, content, mimeType, fileId) {
        return this.client.uploadText(folderId, filename, content, mimeType, fileId);
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
    async trashFile(fileId) {
        return this.client.trashFile(fileId);
    }
    clearFolderCache() {
        writeScriptVariable(FOLDER_CACHE_KEY, {});
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
function dedupeVersions(versions) {
    const seen = new Map();
    for (const version of versions) {
        seen.set(version.fileId, version);
    }
    return [...seen.values()];
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
        const contextKey = this.tavern.captureEnvironmentContext?.();
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
            let snapshot;
            let preparationStep = 'download';
            try {
                onProgress?.({ kind: entry.kind, step: 'download', state: 'start' });
                const downloaded = await this.drive.downloadJson(entry.latest.fileId);
                onProgress?.({ kind: entry.kind, step: 'download', state: 'done', filename: entry.latest.filename });
                preparationStep = 'validate';
                onProgress?.({ kind: entry.kind, step: 'validate', state: 'start' });
                snapshot = parseEnvironmentSnapshot(entry.kind, downloaded);
                onProgress?.({ kind: entry.kind, step: 'validate', state: 'done', filename: entry.latest.filename });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                onProgress?.({ kind: entry.kind, step: preparationStep, state: 'error', error: message });
                items.push({ kind: entry.kind, status: 'error', error: message });
                continue;
            }
            // 覆蓋前備份：遠端資料先通過驗證；目前資料也必須有效才能建立還原點。
            try {
                this.assertContext(contextKey);
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'start' });
                const folderId = await this.drive.ensureFolderPath([...restorePointPath, entry.kind]);
                const currentSnapshot = parseEnvironmentSnapshot(entry.kind, await this.exportSnapshot(entry.kind));
                this.assertContext(contextKey);
                await this.drive.uploadJson(folderId, restorePointFilename, currentSnapshot);
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'done', filename: restorePointFilename });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                onProgress?.({ kind: entry.kind, step: 'backup_current', state: 'error', error: message });
                items.push({ kind: entry.kind, status: 'aborted', error: message });
                continue;
            }
            // apply 失敗標記 error，其他無相依項目繼續。
            const step = 'apply';
            try {
                this.assertContext(contextKey);
                onProgress?.({ kind: entry.kind, step: 'apply', state: 'start' });
                await this.applySnapshot(snapshot, contextKey);
                this.assertContext(contextKey);
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
    async applySnapshot(snapshot, contextKey) {
        if (snapshot.kind === 'character') {
            await this.tavern.applyCharacter(snapshot, contextKey);
            return;
        }
        if (snapshot.kind === 'world') {
            await this.tavern.applyWorld(snapshot, contextKey);
            return;
        }
        if (snapshot.kind === 'persona') {
            await this.tavern.applyPersona(snapshot, contextKey);
            return;
        }
        if (snapshot.kind === 'preset') {
            await this.tavern.applyPreset(snapshot, contextKey);
            return;
        }
        await this.tavern.applyRegex(snapshot, contextKey);
    }
    assertContext(contextKey) {
        if (contextKey && this.tavern.isEnvironmentContextCurrent && !this.tavern.isEnvironmentContextCurrent(contextKey)) {
            throw new Error('操作期間角色或聊天已切換，環境還原已中止');
        }
    }
}
function EnvironmentRestoreService_environmentItemPath(meta, kind) {
    return ['SillyTavernSync', meta.role_key, meta.chat_id, kind];
}

;// ./src/restorePoints/RestorePointService.ts


const RestorePointService_ROOT_FOLDER = 'SillyTavernSync';
const RESTORE_FOLDER = '_pre_restore';
const RESERVED_CHAT_FOLDERS = new Set(['_pre_restore', '_self_check']);
const RESTORE_POINT_KINDS = new Set([
    'chat', 'character', 'world', 'persona', 'preset', 'regex'
]);
class RestorePointService {
    drive;
    constructor(drive) {
        this.drive = drive;
    }
    async listChats() {
        const targets = await this.discoverTargets();
        const summaries = await mapWithConcurrency([...targets.values()], 4, async (target) => {
            const batchFolders = await this.listBatchFolders(target.restoreRoots);
            const looseRoots = (await Promise.all(target.restoreRoots.map(async (root) => ({
                root,
                files: await this.drive.listFilesInFolder(root.id)
            })))).filter(item => item.files.length > 0);
            const latest = [...batchFolders.map(resolveBatchCreatedAt), ...looseRoots.map(item => normalizeDate(item.root.createdAt))]
                .sort((left, right) => right.localeCompare(left))[0] ?? null;
            return {
                key: targetKey(target),
                roleKey: target.roleKey,
                chatId: target.chatId,
                batchCount: batchFolders.length + looseRoots.length,
                latestCreatedAt: latest,
                restoreRootCount: target.restoreRoots.length,
                duplicatePath: target.roleFolderIds.size > 1 || target.chatFolderIds.size > 1 || target.restoreRoots.length > 1
            };
        });
        return summaries.sort((left, right) => {
            const byLatest = (right.latestCreatedAt ?? '').localeCompare(left.latestCreatedAt ?? '');
            return byLatest || left.roleKey.localeCompare(right.roleKey) || left.chatId.localeCompare(right.chatId);
        });
    }
    async listChat(target) {
        assertTarget(target);
        const targets = await this.discoverTargets();
        const discovered = targets.get(targetKey(target));
        if (!discovered)
            return [];
        return this.listDiscoveredChat(discovered);
    }
    async listDiscoveredChat(discovered) {
        const folders = await this.listBatchFolders(discovered.restoreRoots);
        const [batches, loose] = await Promise.all([
            Promise.all(folders.map(folder => this.readBatch(folder, discovered))),
            Promise.all(discovered.restoreRoots.map(root => this.readLooseRootFiles(root, discovered)))
        ]);
        batches.push(...loose.filter((batch) => Boolean(batch)));
        return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    async previewCleanup(days, target, now = new Date()) {
        if (!Number.isInteger(days) || days <= 0)
            throw new Error('保留天數必須是正整數');
        const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
        const discovered = await this.discoverTargets();
        const selectedTargets = target
            ? [discovered.get(targetKey(target))].filter((item) => Boolean(item))
            : [...discovered.values()];
        const batches = (await mapWithConcurrency(selectedTargets, 4, item => this.listDiscoveredChat(item))).flat();
        const files = batches.flatMap(batch => batch.files).filter(file => {
            const uploadedAt = Date.parse(file.uploadedAt);
            return Number.isFinite(uploadedAt) && uploadedAt < cutoff;
        });
        const targets = dedupeSelections(files.map(file => selectionFromFile(file)));
        return {
            days,
            scope: target ? 'chat' : 'all',
            targets,
            roleCount: new Set(files.map(file => file.roleKey)).size,
            chatCount: new Set(files.map(file => targetKey(file))).size,
            batchCount: new Set(files.map(file => file.batchFolderId)).size
        };
    }
    async trashFiles(selections) {
        return this.mutateFiles(selections, fileId => this.drive.trashFile(fileId));
    }
    async deleteFilesPermanently(selections) {
        return this.mutateFiles(selections, fileId => this.drive.deleteFile(fileId));
    }
    async mutateFiles(selections, operation) {
        const requested = dedupeSelections(selections);
        if (requested.length === 0)
            return { requested: 0, affected: 0, failed: [] };
        await this.assertSelectionsBelongToTargets(requested);
        const settled = await Promise.all(requested.map(async (selection) => {
            try {
                await operation(selection.fileId);
                return { fileId: selection.fileId, affected: true };
            }
            catch (error) {
                if (error instanceof DriveError && error.status === 404) {
                    return { fileId: selection.fileId, affected: true };
                }
                return {
                    fileId: selection.fileId,
                    affected: false,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }));
        return {
            requested: requested.length,
            affected: settled.filter(item => item.affected).length,
            failed: settled
                .filter((item) => !item.affected)
                .map(item => ({ fileId: item.fileId, error: item.error }))
        };
    }
    async assertSelectionsBelongToTargets(selections) {
        const grouped = new Map();
        for (const selection of selections) {
            assertTarget(selection);
            const key = targetKey(selection);
            grouped.set(key, [...(grouped.get(key) ?? []), selection]);
        }
        const discovered = await this.discoverTargets();
        for (const [key, group] of grouped) {
            const target = group[0];
            if (!target)
                continue;
            const discoveredTarget = discovered.get(key);
            const batches = discoveredTarget ? await this.listDiscoveredChat(discoveredTarget) : [];
            const allowedIds = new Set(batches.flatMap(batch => batch.files.map(file => file.fileId)));
            const unknown = group.find(item => !allowedIds.has(item.fileId));
            if (unknown) {
                throw new Error(`檔案 ${unknown.fileId} 不屬於指定的 _pre_restore，已中止操作`);
            }
        }
    }
    async discoverTargets() {
        const targets = new Map();
        const roles = await this.drive.listChildFolders([RestorePointService_ROOT_FOLDER]);
        await Promise.all(roles.map(async (role) => {
            const chats = await this.drive.listFoldersInFolder(role.id);
            await Promise.all(chats
                .filter(chat => !RESERVED_CHAT_FOLDERS.has(chat.name))
                .map(async (chat) => {
                const restoreRoots = (await this.drive.listFoldersInFolder(chat.id))
                    .filter(folder => folder.name === RESTORE_FOLDER);
                if (restoreRoots.length === 0)
                    return;
                const key = targetKey({ roleKey: role.name, chatId: chat.name });
                const existing = targets.get(key) ?? {
                    roleKey: role.name,
                    chatId: chat.name,
                    roleFolderIds: new Set(),
                    chatFolderIds: new Set(),
                    restoreRoots: []
                };
                existing.roleFolderIds.add(role.id);
                existing.chatFolderIds.add(chat.id);
                existing.restoreRoots.push(...restoreRoots);
                targets.set(key, existing);
            }));
        }));
        return targets;
    }
    async listBatchFolders(restoreRoots) {
        const folders = (await Promise.all(restoreRoots.map(root => this.drive.listFoldersInFolder(root.id)))).flat();
        return dedupeItems(folders);
    }
    async readBatch(folder, target) {
        const directFiles = await this.drive.listFilesInFolder(folder.id);
        const childFolders = await this.drive.listFoldersInFolder(folder.id);
        const visited = new Set([folder.id]);
        const nested = await Promise.all(childFolders.map(child => this.readNestedFolder(child, folder, target, child.name, restorePointKind(child.name), visited)));
        const files = [
            ...directFiles.map(file => toRestorePointFile(file, inferDirectKind(file), '', folder, target)),
            ...nested.flatMap(result => result.files)
        ].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
        const emptyFolders = nested.flatMap(result => result.emptyFolders);
        const issues = [];
        if (files.length === 0)
            issues.push('empty');
        if (!parseUtcTimestamp(folder.name))
            issues.push('invalid_timestamp');
        if (directFiles.some(file => inferDirectKind(file) === 'other') || nested.some(result => result.hasUnknownItems)) {
            issues.push('unknown_items');
        }
        return {
            ...target,
            folderId: folder.id,
            name: folder.name,
            createdAt: resolveBatchCreatedAt(folder),
            files,
            emptyFolders,
            issues
        };
    }
    async readLooseRootFiles(root, target) {
        const directFiles = await this.drive.listFilesInFolder(root.id);
        if (directFiles.length === 0)
            return null;
        const batchName = '_pre_restore 根目錄（未歸入批次）';
        const batch = { ...root, name: batchName };
        const files = directFiles
            .map(file => toRestorePointFile(file, inferDirectKind(file), '', batch, target))
            .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
        return {
            ...target,
            folderId: root.id,
            name: batchName,
            createdAt: normalizeDate(root.createdAt),
            files,
            emptyFolders: [],
            issues: ['invalid_timestamp', ...(files.some(file => file.kind === 'other') ? ['unknown_items'] : [])]
        };
    }
    async readNestedFolder(folder, batch, target, relativePath, kind, visited) {
        if (visited.has(folder.id))
            return { files: [], emptyFolders: [], hasUnknownItems: true };
        visited.add(folder.id);
        const [directFiles, childFolders] = await Promise.all([
            this.drive.listFilesInFolder(folder.id),
            this.drive.listFoldersInFolder(folder.id)
        ]);
        const nested = await Promise.all(childFolders.map(child => this.readNestedFolder(child, batch, target, `${relativePath}/${child.name}`, kind, visited)));
        const files = [
            ...directFiles.map(file => toRestorePointFile(file, kind, relativePath, batch, target)),
            ...nested.flatMap(result => result.files)
        ];
        const emptyFolders = nested.flatMap(result => result.emptyFolders);
        if (directFiles.length === 0 && childFolders.length === 0) {
            emptyFolders.push({
                folderId: folder.id,
                name: folder.name,
                relativePath,
                createdAt: normalizeDate(folder.createdAt),
                empty: true
            });
        }
        return {
            files,
            emptyFolders,
            hasUnknownItems: kind === 'other' || nested.some(result => result.hasUnknownItems)
        };
    }
}
function toRestorePointFile(file, kind, parentName, batch, target) {
    return {
        ...target,
        fileId: file.id,
        filename: file.name,
        kind,
        relativePath: parentName ? `${parentName}/${file.name}` : file.name,
        batchFolderId: batch.id,
        batchName: batch.name,
        uploadedAt: normalizeDate(file.createdAt),
        updatedAt: normalizeDate(file.updatedAt)
    };
}
function inferDirectKind(file) {
    return file.name.toLowerCase().endsWith('.jsonl') ? 'chat' : 'other';
}
function restorePointKind(folderName) {
    return RESTORE_POINT_KINDS.has(folderName)
        ? folderName
        : 'other';
}
function resolveBatchCreatedAt(folder) {
    return parseUtcTimestamp(folder.name)?.toISOString() ?? normalizeDate(folder.createdAt);
}
function normalizeDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '1970-01-01T00:00:00.000Z' : date.toISOString();
}
function targetKey(target) {
    return JSON.stringify([target.roleKey, target.chatId]);
}
function selectionFromFile(file) {
    return { fileId: file.fileId, roleKey: file.roleKey, chatId: file.chatId };
}
function dedupeSelections(selections) {
    const unique = new Map();
    for (const selection of selections) {
        if (selection.fileId)
            unique.set(selection.fileId, selection);
    }
    return [...unique.values()];
}
function dedupeItems(items) {
    return [...new Map(items.map(item => [item.id, item])).values()];
}
function assertTarget(target) {
    if (!target.roleKey.trim() || !target.chatId.trim())
        throw new Error('還原點的角色與對話不可為空');
}
async function mapWithConcurrency(items, limit, operation) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            const item = items[index];
            if (item !== undefined)
                results[index] = await operation(item);
        }
    });
    await Promise.all(workers);
    return results;
}

;// ./src/selfCheck.ts






const cases = [];
const DEFAULT_TIMEOUT_MS = 12_000;
let activeRun = null;
function registerSelfCheck(testCase) {
    if (cases.some(existing => existing.id === testCase.id)) {
        return;
    }
    cases.push(testCase);
}
function getSelfCheckCases(mode) {
    return cases.filter(testCase => !mode || testCase.mode === mode).map(testCase => ({ ...testCase }));
}
function runSelfChecks(options = {}) {
    if (activeRun) {
        return activeRun;
    }
    const selected = getSelfCheckCases(options.mode ?? 'quick');
    const run = executeSelfChecks(selected, options.onProgress);
    const wrapped = run.finally(() => {
        if (activeRun === wrapped)
            activeRun = null;
    });
    activeRun = wrapped;
    return wrapped;
}
async function executeSelfChecks(selected, onProgress) {
    const results = [];
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
async function executeCase(testCase) {
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
    }
    catch (error) {
        return {
            id: testCase.id,
            label: testCase.label,
            category: testCase.category,
            safety: testCase.safety,
            mode: testCase.mode,
            status: 'fail',
            message: selfCheck_errorMessage(error),
            remediation: '請重試；若持續失敗，請複製診斷報告並確認酒館助手版本。',
            startedAt,
            durationMs: Math.round(performance.now() - started)
        };
    }
}
function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}逾時（${timeoutMs}ms）`)), timeoutMs);
        promise.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function registerPhase0SelfChecks() {
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
function registerApiSpikeSelfChecks(tavern) {
    for (const kind of ['character', 'world', 'persona', 'preset', 'regex']) {
        registerSelfCheck(createEnvironmentExportCase(tavern.environment, kind));
    }
    for (const kind of ['character', 'world', 'persona', 'preset', 'regex']) {
        registerSelfCheck(createEnvironmentRestoreCapabilityCase(tavern.diagnostics, kind));
    }
    registerAdvancedCharacterRoundtrip(tavern.diagnostics);
}
function createEnvironmentExportCase(adapter, kind) {
    return {
        id: `environment.export.${kind}`,
        label: `${environmentLabel(kind)}備份資料`,
        category: 'environment_backup',
        safety: 'read_only',
        mode: 'quick',
        timeoutMs: kind === 'world' ? 20_000 : DEFAULT_TIMEOUT_MS,
        async run() {
            let snapshot;
            try {
                snapshot = await exportEnvironmentSnapshot(adapter, kind);
            }
            catch (error) {
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
function createEnvironmentRestoreCapabilityCase(diagnostics, kind) {
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
function registerAdvancedCharacterRoundtrip(diagnostics) {
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
            if (!probe.selected)
                return blockedForChat('請先選擇專用測試角色。');
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
function registerDriveSelfChecks(drive, getState) {
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
            let folderId = null;
            let fileId = null;
            let primaryError = null;
            const cleanupErrors = [];
            try {
                folderId = await drive.ensureFolderPath(path);
                const uploaded = await drive.uploadJson(folderId, filename, payload);
                fileId = uploaded.id;
                const versions = await drive.listVersions(folderId);
                const downloaded = await drive.downloadJson(fileId);
                if (!versions.some(version => version.fileId === fileId) || downloaded.marker !== payload.marker) {
                    throw new Error('Drive 上傳、列舉或下載內容不一致');
                }
            }
            catch (error) {
                primaryError = selfCheck_errorMessage(error);
            }
            finally {
                if (fileId) {
                    try {
                        await drive.deleteFile(fileId);
                        fileId = null;
                    }
                    catch (error) {
                        cleanupErrors.push(`檔案清理失敗：${selfCheck_errorMessage(error)}`);
                    }
                }
                if (folderId && !fileId) {
                    try {
                        await drive.deleteFile(folderId);
                        folderId = null;
                    }
                    catch (error) {
                        cleanupErrors.push(`資料夾清理失敗：${selfCheck_errorMessage(error)}`);
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
function registerChatSelfChecks(tavern) {
    registerSelfCheck({
        id: 'chat.context.ready',
        label: '目前角色與聊天',
        category: 'chat',
        safety: 'read_only',
        mode: 'quick',
        async run() {
            const context = tavern.shell.getContext();
            let chatFileName = null;
            try {
                chatFileName = tavern.chatSync.getCurrentChatFileName();
            }
            catch {
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
            if (missing.length > 0)
                return missingApi(missing);
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
            const swipeCount = messages.filter(message => Array.isArray(message.swipes)).length;
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
            let chatFileName = null;
            try {
                chatFileName = tavern.chatSync.getCurrentChatFileName();
            }
            catch {
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
function registerAdvancedChatRoundtrip(tavern) {
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
            if (missing.length > 0)
                return missingApi(missing);
            const adapter = tavern.chatSync;
            const originalMessages = adapter.getMessages();
            if (originalMessages.length === 0)
                return blockedForChat('目前聊天沒有訊息可供測試。');
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
            }
            finally {
                if (!restored)
                    await adapter.replaceChat(original);
            }
        }
    });
}
function registerPullSelfChecks(tavern) {
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
            let files;
            try {
                files = await adapter.listCharacterChatFiles(currentCharacter);
            }
            catch (error) {
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
async function exportEnvironmentSnapshot(adapter, kind) {
    if (kind === 'character')
        return adapter.exportCharacter();
    if (kind === 'world')
        return adapter.exportWorld();
    if (kind === 'persona')
        return adapter.exportPersona();
    if (kind === 'preset')
        return adapter.exportPreset();
    return adapter.exportRegex();
}
function validateEnvironmentSnapshot(snapshot, kind) {
    try {
        snapshot = parseEnvironmentSnapshot(kind, snapshot);
    }
    catch {
        return null;
    }
    if (snapshot.kind === 'character')
        return snapshot.data ? '角色卡可讀且 snapshot 格式正確' : null;
    if (snapshot.kind === 'world') {
        return snapshot.books && snapshot.bindings
            ? `世界書 bundle 可建立，共 ${Object.keys(snapshot.books).length} 本`
            : null;
    }
    if (snapshot.kind === 'persona')
        return snapshot.data ? '目前 Persona 可讀且 snapshot 格式正確' : null;
    if (snapshot.kind === 'preset') {
        if (!snapshot.name || snapshot.format !== 'sillytavern-openai-preset-v1' || !snapshot.data)
            return null;
        const data = snapshot.data;
        return Array.isArray(data.prompts) && Array.isArray(data.prompt_order) && data.extensions
            ? `目前預設「${snapshot.name}」原始結構完整可讀（${data.prompts.length} 個 Prompt、${data.prompt_order.length} 組排序設定）`
            : null;
    }
    return Array.isArray(snapshot.items) ? `可讀取 ${snapshot.items.length} 條全域 Regex` : null;
}
function summarizeSnapshot(snapshot) {
    if (snapshot.kind === 'character')
        return { kind: snapshot.kind, characterName: snapshot.characterName };
    if (snapshot.kind === 'world')
        return { kind: snapshot.kind, bookCount: Object.keys(snapshot.books).length, bindings: snapshot.bindings };
    if (snapshot.kind === 'persona')
        return { kind: snapshot.kind, name: snapshot.name };
    if (snapshot.kind === 'preset') {
        const data = snapshot.data;
        return {
            kind: snapshot.kind,
            name: snapshot.name,
            format: snapshot.format ?? 'legacy',
            promptCount: Array.isArray(data?.prompts) ? data.prompts.length : null,
            unusedPromptCount: Array.isArray(data?.prompts_unused) ? data.prompts_unused.length : null,
            extensionKeys: data?.extensions && typeof data.extensions === 'object'
                ? Object.keys(data.extensions)
                : []
        };
    }
    return { kind: snapshot.kind, itemCount: snapshot.items.length };
}
function environmentLabel(kind) {
    return ({ character: '角色卡', world: '世界書', persona: 'Persona', preset: 'Preset', regex: 'Regex' })[kind];
}
function blockedForChat(remediation) {
    return {
        status: 'blocked',
        message: '缺少目前角色或聊天',
        remediation,
        action: 'select_chat'
    };
}
function environmentSelectionRemediation(kind) {
    if (kind === 'character')
        return '請先選擇一個角色，再檢查角色卡備份。';
    if (kind === 'world')
        return '請先選擇角色並開啟聊天，再檢查世界書備份。';
    return `請先選擇可用的 ${environmentLabel(kind)}，再檢查備份。`;
}
function isMissingSelectionError(error) {
    const message = selfCheck_errorMessage(error).toLowerCase();
    return [
        "角色卡 'current' 不存在",
        '未打开任何聊天',
        '未開啟任何聊天',
        '無法取得目前角色',
        '無法取得目前 sillytavern 原始聊天檔資訊'
    ].some(fragment => message.includes(fragment.toLowerCase()));
}
function missingApi(names) {
    return {
        status: 'fail',
        message: `缺少 API：${names.join(', ')}`,
        remediation: '請更新酒館助手或確認 SillyTavern 版本相容。',
        details: { missing: names }
    };
}
function selfCheck_errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

;// ./src/tavern/host.ts
function getTavernGlobals() {
    return globalThis;
}
function getSillyTavernContext() {
    const candidates = [getTavernGlobals(), safeParentWindow()].filter(Boolean);
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

;// ./src/tavern/capabilities.ts

function detectTavernCapabilities() {
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

;// ./src/tavern/helpers.ts
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
function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function omitUndefined(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

;// ./src/tavern/chatRef.ts


function getCurrentCharacterAvatarUrl() {
    const context = getSillyTavernContext();
    const characterId = readOptionalString(context?.characterId);
    const characterIndex = characterId === undefined ? Number.NaN : Number(characterId);
    const character = Array.isArray(context?.characters) && Number.isInteger(characterIndex) ? context.characters[characterIndex] : null;
    const avatarUrl = readOptionalString(character?.avatar);
    if (!avatarUrl) {
        throw new Error('無法取得目前角色的 avatar');
    }
    return avatarUrl;
}
function getCurrentRawChatInfo() {
    const context = getSillyTavernContext();
    const chatId = readOptionalString(context?.getCurrentChatId?.()) ?? readOptionalString(context?.chatId);
    const contextFileName = readOptionalString(context?.chatFileName) ??
        readOptionalString(context?.chat_file_name) ??
        readOptionalString(context?.chat?.file_name);
    const avatarUrl = getCurrentCharacterAvatarUrl();
    if (!chatId) {
        throw new Error('無法取得目前 SillyTavern 原始聊天檔資訊');
    }
    return {
        nativeChatId: chatId,
        rawFileName: chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`,
        displayFileName: contextFileName ?? (chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`),
        avatarUrl
    };
}

;// ./src/tavern/request.ts

function getRequestHeaders() {
    const headers = getSillyTavernContext()?.getRequestHeaders?.();
    if (headers && typeof headers === 'object') {
        return headers;
    }
    return { 'Content-Type': 'application/json' };
}
function postTavernJson(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache'
    });
}

;// ./src/tavern/rawChat.ts





function createRawChatAdapter() {
    return {
        async exportRawChat(ref) {
            const chatInfo = ref ?? getCurrentRawChatInfo();
            const response = await postTavernJson('/api/chats/export', {
                file: chatInfo.rawFileName,
                avatar_url: chatInfo.avatarUrl,
                exportfilename: chatInfo.rawFileName,
                format: 'jsonl',
                is_group: false
            });
            if (!response.ok)
                throw new Error(`SillyTavern raw chat export failed: ${response.status}`);
            const result = await response.json();
            if (typeof result.result !== 'string') {
                throw new Error(typeof result.message === 'string' ? result.message : 'SillyTavern raw chat export did not return JSONL');
            }
            return { content: result.result, messageCount: countRawChatMessages(result.result) };
        },
        async replaceRawChat(content, ref) {
            const chatInfo = ref ?? getCurrentRawChatInfo();
            const response = await postTavernJson('/api/chats/save', {
                avatar_url: chatInfo.avatarUrl,
                file_name: chatInfo.nativeChatId,
                chat: parseRawChatMessages(content),
                force: true
            });
            if (!response.ok)
                throw new Error(`SillyTavern raw chat save failed: ${response.status}`);
            let shouldReload = !ref;
            try {
                shouldReload ||= Boolean(ref && sameChatRef(getCurrentRawChatInfo(), ref));
            }
            catch {
                shouldReload = false;
            }
            if (shouldReload)
                await getSillyTavernContext()?.reloadCurrentChat?.();
        }
    };
}
function parseRawChatMessages(content) {
    return parseRawChatContent(content).rows;
}
function countRawChatMessages(content) {
    return parseRawChatContent(content).messageCount;
}

;// ./src/tavern/chatPull.ts






function createTavernPullAdapter() {
    const globals = getTavernGlobals();
    const adapter = {
        listCharacterNames() {
            return adapter.listCharacters().map(character => character.name);
        },
        listCharacters() {
            const context = getSillyTavernContext();
            if (!Array.isArray(context?.characters))
                return [];
            return context.characters.flatMap((character) => {
                const name = readOptionalString(character?.name);
                const avatarUrl = readOptionalString(character?.avatar);
                return name && avatarUrl ? [{ name, avatarUrl }] : [];
            });
        },
        async selectCharacter(character) {
            const context = getSillyTavernContext();
            if (!Array.isArray(context?.characters) || typeof context?.selectCharacterById !== 'function') {
                throw new Error('酒館 selectCharacterById API 不可用');
            }
            const index = context.characters.findIndex((candidate) => candidate?.name === character.name && candidate?.avatar === character.avatarUrl);
            if (index < 0)
                throw new Error(`本地找不到角色卡：${character.name}`);
            await context.selectCharacterById(index);
        },
        getCurrentCharacterRef() {
            const context = getSillyTavernContext();
            const characterId = readOptionalString(context?.characterId);
            const index = characterId === undefined ? Number.NaN : Number(characterId);
            const character = Array.isArray(context?.characters) && Number.isInteger(index) ? context.characters[index] : null;
            const name = readOptionalString(character?.name) ?? adapter.getCurrentCharacterName();
            const avatarUrl = readOptionalString(character?.avatar);
            return name && avatarUrl ? { name, avatarUrl } : null;
        },
        getCurrentCharacterName() {
            const context = getSillyTavernContext();
            const globalName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
            return globalName ?? readOptionalString(context?.name2) ?? null;
        },
        async listCharacterChatFiles(character) {
            const response = await postTavernJson('/api/characters/chats', {
                avatar_url: character.avatarUrl,
                simple: true
            });
            if (!response.ok)
                throw new Error(`SillyTavern 聊天清單讀取失敗: ${response.status}`);
            const result = await response.json();
            const rows = Array.isArray(result) ? result : Object.values(result);
            return rows.map(row => readOptionalString(row?.file_name)).filter((name) => Boolean(name));
        },
        async createChatFile(character, fileName, rawJsonl) {
            const response = await postTavernJson('/api/chats/save', {
                avatar_url: character.avatarUrl,
                file_name: fileName,
                chat: parseRawChatMessages(rawJsonl),
                force: true
            });
            if (!response.ok)
                throw new Error(`SillyTavern 聊天檔建立失敗: ${response.status}`);
        },
        async openChatFile(character, fileName) {
            const context = getSillyTavernContext();
            if (typeof context?.openCharacterChat !== 'function') {
                throw new Error('酒館 openCharacterChat API 不可用，無法開啟從雲端建立的聊天');
            }
            const current = adapter.getCurrentCharacterRef();
            if (!current || current.avatarUrl !== character.avatarUrl)
                throw new Error('角色已切換，未開啟雲端聊天');
            await context.openCharacterChat(fileName);
        },
        getCurrentChatFileName() {
            try {
                return getCurrentRawChatInfo().displayFileName;
            }
            catch {
                return null;
            }
        },
        exportRawChat() {
            return createRawChatAdapter().exportRawChat();
        },
        async applyCharacter(snapshot) {
            if (typeof globals.createOrReplaceCharacter !== 'function')
                throw new Error('Character restore API is unavailable');
            await globals.createOrReplaceCharacter(snapshot.characterName ?? 'Imported Character', snapshot.data, { render: 'none' });
        },
        writeChatMeta(meta) {
            if (typeof globals.insertOrAssignVariables !== 'function')
                throw new Error('酒館助手 chat 變數 API 不可用');
            globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
        }
    };
    adapter.selectCharacterByName = async (name) => {
        const matches = adapter.listCharacters().filter(character => character.name === name);
        if (matches.length !== 1)
            throw new Error(matches.length === 0 ? `本地找不到角色卡：${name}` : `本地有多張同名角色卡：${name}`);
        await adapter.selectCharacter(matches[0]);
    };
    adapter.listCurrentCharacterChatFiles = async () => {
        const current = adapter.getCurrentCharacterRef();
        if (!current)
            throw new Error('目前沒有可辨識的角色卡');
        return adapter.listCharacterChatFiles(current);
    };
    adapter.createAndOpenChatFile = async (fileName, rawJsonl) => {
        const current = adapter.getCurrentCharacterRef();
        if (!current)
            throw new Error('目前沒有可辨識的角色卡');
        const context = getSillyTavernContext();
        if (typeof context?.openCharacterChat !== 'function')
            throw new Error('酒館 openCharacterChat API 不可用，無法開啟從雲端建立的聊天');
        await adapter.createChatFile(current, fileName, rawJsonl);
        await adapter.openChatFile(current, fileName);
    };
    return adapter;
}

;// ./src/tavern/chatMessages.ts




function createChatMessageAdapter() {
    const globals = getTavernGlobals();
    return {
        getMessages() {
            if (typeof globals.getChatMessages !== 'function') {
                throw new Error('酒館助手聊天訊息 API 不可用');
            }
            return globals.getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
        },
        getChatWorldbook() {
            return typeof globals.getChatWorldbookName === 'function' ? globals.getChatWorldbookName('current') : null;
        },
        async replaceChat(chatPackage, ref) {
            assertCurrentChat(ref);
            if (typeof globals.deleteChatMessages !== 'function' || typeof globals.createChatMessages !== 'function') {
                throw new Error('酒館助手聊天覆寫 API 不可用');
            }
            const lastMessageId = typeof globals.getLastMessageId === 'function' ? globals.getLastMessageId() : -1;
            if (lastMessageId >= 0) {
                await globals.deleteChatMessages(Array.from({ length: lastMessageId + 1 }, (_value, index) => index), { refresh: 'none' });
            }
            assertCurrentChat(ref);
            await globals.createChatMessages(chatPackage.messages.map(message => toCreatableChatMessage(message)), { insert_before: 'end', refresh: 'all' });
            assertCurrentChat(ref);
            if (typeof globals.setChatMessages === 'function') {
                await globals.setChatMessages(chatPackage.messages.map((message, index) => toRestorableChatMessage(message, index)), { refresh: 'all' });
            }
            assertCurrentChat(ref);
            if (chatPackage.chat_worldbook && typeof globals.rebindChatWorldbook === 'function') {
                await globals.rebindChatWorldbook('current', chatPackage.chat_worldbook);
            }
            assertCurrentChat(ref);
            if (typeof globals.replaceVariables === 'function') {
                globals.replaceVariables(chatPackage.chat_variables, { type: 'chat' });
            }
            else if (typeof globals.insertOrAssignVariables === 'function') {
                globals.insertOrAssignVariables(chatPackage.chat_variables, { type: 'chat' });
            }
        }
    };
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
    return omitUndefined({ ...message, message_id: index, message: current.message, data: current.data, extra: current.extra });
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
    if (message.role === 'system' || message.role === 'assistant' || message.role === 'user')
        return message.role;
    if (message.is_user === true)
        return 'user';
    if (message.is_system === true)
        return 'system';
    return 'assistant';
}
function clampSwipeId(value, length) {
    if (!Number.isInteger(value) || value < 0)
        return 0;
    return Math.min(value, Math.max(0, length - 1));
}
function assertCurrentChat(ref) {
    if (ref && !sameChatRef(getCurrentRawChatInfo(), ref)) {
        throw new Error('聊天已切換，已中止更新以避免覆蓋其他聊天');
    }
}

;// ./src/tavern/chatMeta.ts


function createChatMetaAdapter() {
    const globals = getTavernGlobals();
    return {
        getChatVariables() {
            return typeof globals.getVariables === 'function' ? { ...globals.getVariables({ type: 'chat' }) } : {};
        },
        writeChatVariables(variables) {
            if (typeof globals.insertOrAssignVariables !== 'function')
                throw new Error('酒館助手 chat 變數 API 不可用');
            globals.insertOrAssignVariables(variables, { type: 'chat' });
        },
        getCurrentCharacterName() {
            return typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
        },
        getCurrentChatFileName() {
            return getCurrentRawChatInfo().displayFileName;
        }
    };
}

;// ./src/tavern/chatSync.ts





function createChatSyncAdapter() {
    return {
        ...createChatMetaAdapter(),
        getCurrentChatRef: getCurrentRawChatInfo,
        isCurrentChat(ref) {
            try {
                return sameChatRef(getCurrentRawChatInfo(), ref);
            }
            catch {
                return false;
            }
        },
        ...createChatMessageAdapter(),
        ...createRawChatAdapter()
    };
}

;// ./src/tavern/environment/context.ts




function createEnvironmentContextAdapter() {
    return {
        captureEnvironmentContext() {
            return captureEnvironmentContextKey();
        },
        isEnvironmentContextCurrent(contextKey) {
            try {
                return captureEnvironmentContextKey() === contextKey;
            }
            catch {
                return false;
            }
        }
    };
}
function captureEnvironmentContextKey() {
    try {
        return JSON.stringify([getContextRevision(), chatRefKey(getCurrentRawChatInfo())]);
    }
    catch {
        const context = getSillyTavernContext();
        return JSON.stringify([
            getContextRevision(),
            context?.characterId ?? null,
            context?.chatId ?? context?.getCurrentChatId?.() ?? null,
            context?.name2 ?? null
        ]);
    }
}
function assertEnvironmentContext(contextKey) {
    if (!contextKey)
        return;
    const current = captureEnvironmentContextKey();
    if (current !== contextKey)
        throw new Error('操作期間角色或聊天已切換，環境還原已中止');
}

;// ./src/tavern/environment/character.ts




function createCharacterAdapter() {
    const globals = getTavernGlobals();
    return {
        async exportCharacter() {
            if (typeof globals.getCharacter !== 'function')
                throw new Error('Character export API is unavailable');
            const data = await globals.getCharacter('current');
            if (!isPlainRecord(data))
                throw new Error('角色卡資料格式不完整');
            const avatar = data.avatar;
            let image;
            if (avatar instanceof Blob) {
                image = avatar;
            }
            else {
                const path = typeof globals.getCharAvatarPath === 'function'
                    ? globals.getCharAvatarPath('current') : null;
                if (typeof path !== 'string' || !path)
                    throw new Error('無法取得角色卡頭像路徑，備份已中止');
                const response = await fetch(path);
                if (!response.ok)
                    throw new Error(`無法讀取角色卡頭像：HTTP ${response.status}`);
                image = await response.blob();
            }
            if (!image.type.startsWith('image/') || image.size === 0) {
                throw new Error('角色卡頭像不是有效圖片，備份已中止');
            }
            const bytes = new Uint8Array(await image.arrayBuffer());
            const chunks = [];
            for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
            }
            const characterName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
            return {
                kind: 'character', exportedAt: new Date().toISOString(), characterName,
                data: { ...data, avatar: typeof avatar === 'string' ? avatar : undefined },
                avatarImage: { mimeType: image.type, base64: btoa(chunks.join('')) }
            };
        },
        async applyCharacter(snapshot, contextKey) {
            const validated = parseEnvironmentSnapshot('character', snapshot);
            assertEnvironmentContext(contextKey);
            if (typeof globals.createOrReplaceCharacter !== 'function')
                throw new Error('Character restore API is unavailable');
            const currentName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
            const data = { ...validated.data };
            if (validated.avatarImage) {
                const binary = atob(validated.avatarImage.base64);
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
                data.avatar = new Blob([bytes], { type: validated.avatarImage.mimeType });
            }
            await globals.createOrReplaceCharacter(validated.characterName ?? currentName ?? 'Imported Character', data, { render: 'none' });
            assertEnvironmentContext(contextKey);
        }
    };
}

;// ./src/tavern/environment/persona.ts




function createPersonaAdapter() {
    const globals = getTavernGlobals();
    return {
        async exportPersona() {
            if (typeof globals.getPersona !== 'function')
                throw new Error('Persona export API is unavailable');
            const data = await globals.getPersona('current');
            if (!isPlainRecord(data))
                throw new Error('Persona 資料格式不完整');
            const avatar = data.avatar;
            let image;
            if (avatar instanceof Blob) {
                image = avatar;
            }
            else {
                const path = typeof globals.getPersonaAvatarPath === 'function'
                    ? globals.getPersonaAvatarPath('current') : null;
                if (typeof path !== 'string' || !path)
                    throw new Error('無法取得 Persona 頭像路徑，備份已中止');
                const response = await fetch(path);
                if (!response.ok)
                    throw new Error(`無法讀取 Persona 頭像：HTTP ${response.status}`);
                image = await response.blob();
            }
            if (!image.type.startsWith('image/') || image.size === 0) {
                throw new Error('Persona 頭像不是有效圖片，備份已中止');
            }
            const bytes = new Uint8Array(await image.arrayBuffer());
            const chunks = [];
            for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
            }
            const currentName = typeof globals.getCurrentCharacterName === 'function' ? globals.getCurrentCharacterName() : null;
            return {
                kind: 'persona', exportedAt: new Date().toISOString(),
                name: readOptionalString(data?.name) ?? currentName,
                data: { ...data, avatar: typeof avatar === 'string' ? avatar : undefined },
                avatarImage: { mimeType: image.type, base64: btoa(chunks.join('')) }
            };
        },
        async applyPersona(snapshot, contextKey) {
            const validated = parseEnvironmentSnapshot('persona', snapshot);
            assertEnvironmentContext(contextKey);
            const context = getSillyTavernContext();
            const personaApi = globals.createOrReplacePersona ?? context?.createOrReplacePersona;
            if (typeof personaApi !== 'function')
                throw new Error('Persona restore API is unavailable');
            const data = { ...validated.data };
            if (validated.avatarImage) {
                const binary = atob(validated.avatarImage.base64);
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
                data.avatar = new Blob([bytes], { type: validated.avatarImage.mimeType });
            }
            await personaApi(validated.name ?? 'Imported Persona', data);
            assertEnvironmentContext(contextKey);
        }
    };
}

;// ./src/tavern/environment/preset.ts




function createPresetAdapter() {
    const globals = getTavernGlobals();
    return {
        async exportPreset() {
            const manager = getSillyTavernContext()?.getPresetManager?.('openai');
            const name = typeof manager?.getSelectedPresetName === 'function' ? manager.getSelectedPresetName() : null;
            const data = name && typeof manager?.getCompletionPresetByName === 'function'
                ? manager.getCompletionPresetByName(name)
                : null;
            if (!name || !isPlainRecord(data))
                throw new Error('Preset export API is unavailable');
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
                if (selectedValue !== null && typeof manager.selectPreset === 'function')
                    manager.selectPreset(selectedValue);
                return;
            }
            if (snapshot.format === 'tavern-helper-preset-v1') {
                if (!snapshot.name || typeof globals.createOrReplacePreset !== 'function' || typeof globals.loadPreset !== 'function') {
                    throw new Error('Complete Preset restore API is unavailable');
                }
                if (!isCompleteTavernHelperPreset(snapshot.data))
                    throw new Error('Complete Preset backup is invalid');
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
            if (!snapshot.name || typeof manager?.savePreset !== 'function')
                throw new Error('Preset restore API is unavailable');
            await manager.savePreset(snapshot.name, snapshot.data, { skipUpdate: false });
            assertEnvironmentContext(contextKey);
            const selectedValue = findPresetOptionValue(manager, snapshot.name);
            if (selectedValue !== null && typeof manager.selectPreset === 'function')
                manager.selectPreset(selectedValue);
        }
    };
}
function findPresetOptionValue(manager, name) {
    if (typeof manager.findPreset === 'function') {
        const found = manager.findPreset(name);
        return typeof found === 'string' ? found : null;
    }
    const selected = manager.getSelectedPreset?.();
    return typeof selected === 'string' ? selected : null;
}
function isCompleteTavernHelperPreset(value) {
    if (!isPlainRecord(value))
        return false;
    return isPlainRecord(value.settings) && Array.isArray(value.prompts) &&
        Array.isArray(value.prompts_unused) && isPlainRecord(value.extensions);
}

;// ./src/tavern/environment/regex.ts



function createRegexAdapter() {
    const globals = getTavernGlobals();
    return {
        async exportRegex() {
            if (typeof globals.getTavernRegexes !== 'function')
                throw new Error('Regex export API is unavailable');
            const items = await globals.getTavernRegexes({ type: 'global' });
            return { kind: 'regex', exportedAt: new Date().toISOString(), scope: 'global', items: Array.isArray(items) ? items : [] };
        },
        async applyRegex(snapshot, contextKey) {
            snapshot = parseEnvironmentSnapshot('regex', snapshot);
            assertEnvironmentContext(contextKey);
            if (typeof globals.replaceTavernRegexes !== 'function')
                throw new Error('Regex restore API is unavailable');
            if (typeof globals.getTavernRegexes !== 'function')
                throw new Error('Regex merge API is unavailable');
            const current = await globals.getTavernRegexes({ type: 'global' });
            assertEnvironmentContext(contextKey);
            if (!Array.isArray(current))
                throw new Error('目前全域 Regex 格式無法讀取');
            const merged = mergeRegexItems(current, snapshot.items);
            await globals.replaceTavernRegexes(merged, { type: snapshot.scope });
            assertEnvironmentContext(contextKey);
        }
    };
}
function mergeRegexItems(current, incoming) {
    const incomingByKey = new Map(incoming.map(item => [regexKey(item), item]));
    const result = current.map(item => incomingByKey.get(regexKey(item)) ?? item);
    const currentKeys = new Set(current.map(regexKey));
    for (const item of incoming) {
        if (!currentKeys.has(regexKey(item)))
            result.push(item);
    }
    return result;
}
function regexKey(value) {
    const item = value;
    const identity = item.scriptName ?? item.name ?? item.id;
    return `${typeof identity}:${String(identity)}`;
}

;// ./src/tavern/environment/world.ts




function createWorldAdapter() {
    const globals = getTavernGlobals();
    return {
        async exportWorld() {
            const context = getSillyTavernContext();
            const raw = typeof context?.loadWorldInfo === 'function';
            if (!raw && typeof globals.getWorldbook !== 'function')
                throw new Error('Worldbook export API is unavailable');
            const bindings = await getWorldBindings(globals);
            const bookNames = uniqueNonEmpty([bindings.chat, bindings.char_primary, ...bindings.char_additional, ...bindings.global_enabled]);
            const books = Object.fromEntries(await Promise.all(bookNames.map(async (name) => {
                try {
                    // Helper conversion calls .map() on optional raw key/keysecondary fields.
                    // Preserve the original JSON, including extension fields and regex strings.
                    const data = raw ? await context.loadWorldInfo(name) : await globals.getWorldbook(name);
                    if (raw ? !isRawWorldbook(data) : !Array.isArray(data)) {
                        throw new Error('世界書資料不存在或格式不完整');
                    }
                    return [name, structuredClone(data)];
                }
                catch (error) {
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
                if (typeof context?.saveWorldInfo !== 'function')
                    throw new Error('Raw Worldbook restore API is unavailable');
                const books = Object.entries(snapshot.books);
                for (const [name, data] of books) {
                    if (!isRawWorldbook(data))
                        throw new Error(`世界書「${name}」的備份格式不完整`);
                }
                for (const [name, data] of books) {
                    assertEnvironmentContext(contextKey);
                    await context.saveWorldInfo(name, structuredClone(data), true);
                    assertEnvironmentContext(contextKey);
                }
                if (books.length > 0 && typeof context.updateWorldInfoList === 'function')
                    await context.updateWorldInfoList();
                assertEnvironmentContext(contextKey);
                for (const [name] of books) {
                    if (typeof context.reloadWorldInfoEditor === 'function')
                        await context.reloadWorldInfoEditor(name);
                    assertEnvironmentContext(contextKey);
                }
            }
            else {
                const createOrReplace = typeof globals.createOrReplaceWorldbook === 'function'
                    ? globals.createOrReplaceWorldbook.bind(globals)
                    : typeof globals.replaceWorldbook === 'function' ? globals.replaceWorldbook.bind(globals) : null;
                if (!createOrReplace)
                    throw new Error('Worldbook restore API is unavailable');
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
async function getWorldBindings(globals) {
    const chat = typeof globals.getChatWorldbookName === 'function' ? await globals.getChatWorldbookName('current') : null;
    const characterBindings = typeof globals.getCharWorldbookNames === 'function' ? await globals.getCharWorldbookNames('current') : null;
    const legacyBindings = normalizeStringArray(characterBindings);
    const globalEnabled = normalizeStringArray(typeof globals.getGlobalWorldbookNames === 'function' ? await globals.getGlobalWorldbookNames() : []);
    return {
        chat: readOptionalString(chat) ?? null,
        char_primary: isPlainRecord(characterBindings) ? normalizeStringArray(characterBindings.primary)[0] ?? null : legacyBindings[0] ?? null,
        char_additional: isPlainRecord(characterBindings) ? normalizeStringArray(characterBindings.additional) : legacyBindings.slice(1),
        global_enabled: globalEnabled
    };
}
function isRawWorldbook(value) {
    return isPlainRecord(value) && isPlainRecord(value.entries) && Object.values(value.entries).every(isPlainRecord);
}

;// ./src/tavern/environment/index.ts







function createEnvironmentAdapter() {
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

;// ./src/tavern/shell.ts


function createTavernShell() {
    let currentChatFileName = null;
    return {
        isAvailable() {
            const globals = getTavernGlobals();
            return typeof globals.getVariables === 'function' || typeof globals.getCurrentCharacterName === 'function';
        },
        getContext(chatFileName = currentChatFileName) {
            currentChatFileName = chatFileName ?? currentChatFileName;
            const globals = getTavernGlobals();
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
        getChatMeta: getChatMetaFromGlobals,
        writeChatMeta(meta) {
            const globals = getTavernGlobals();
            if (typeof globals.insertOrAssignVariables !== 'function')
                throw new Error('酒館助手 chat 變數 API 不可用');
            globals.insertOrAssignVariables({ [CHAT_META_KEY]: meta }, { type: 'chat' });
        },
        onChatChanged(handler) {
            const globals = getTavernGlobals();
            const eventName = globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed';
            if (typeof globals.eventOn !== 'function')
                return () => undefined;
            const listener = (chatFileName) => {
                currentChatFileName = chatFileName ?? null;
                handler(currentChatFileName);
            };
            const subscription = globals.eventOn(eventName, listener);
            return () => subscription?.stop?.();
        },
        onChatContentChanged(handler) {
            const globals = getTavernGlobals();
            if (typeof globals.eventOn !== 'function')
                return () => undefined;
            const eventNames = [
                globals.tavern_events?.MESSAGE_SENT ?? 'message_sent',
                globals.tavern_events?.MESSAGE_RECEIVED ?? 'message_received',
                globals.tavern_events?.MESSAGE_EDITED ?? 'message_edited',
                globals.tavern_events?.MESSAGE_DELETED ?? 'message_deleted',
                globals.tavern_events?.MESSAGE_SWIPED ?? 'message_swiped'
            ];
            const subscriptions = [...new Set(eventNames)].flatMap(eventName => {
                try {
                    return [globals.eventOn(eventName, handler)];
                }
                catch {
                    return [];
                }
            });
            return () => subscriptions.forEach(subscription => subscription?.stop?.());
        },
        onMessageCompleted(handler) {
            const globals = getTavernGlobals();
            const eventName = globals.tavern_events?.GENERATION_ENDED ?? globals.tavern_events?.MESSAGE_RECEIVED ?? 'generation_ended';
            if (typeof globals.eventOn !== 'function')
                return () => undefined;
            const subscription = globals.eventOn(eventName, handler);
            return () => subscription?.stop?.();
        },
        notify(message, kind = 'info') {
            const notifier = getTavernGlobals().toastr?.[kind];
            if (typeof notifier === 'function')
                notifier(message);
            else
                console.log(`[TavernRoamer] ${message}`);
        }
    };
}
function getChatMetaFromGlobals() {
    const globals = getTavernGlobals();
    if (typeof globals.getVariables !== 'function')
        return null;
    const value = globals.getVariables({ type: 'chat' })?.[CHAT_META_KEY];
    if (!value || typeof value !== 'object')
        return null;
    const meta = value;
    return typeof meta.chat_id === 'string' && typeof meta.role_key === 'string' ? value : null;
}

;// ./src/tavern/diagnostics.ts

function createTavernDiagnostics() {
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
function environmentRestoreMissing(kind) {
    const globals = getTavernGlobals();
    const context = getSillyTavernContext();
    const missing = [];
    if (kind === 'character' && typeof globals.createOrReplaceCharacter !== 'function')
        missing.push('createOrReplaceCharacter');
    if (kind === 'world') {
        if (typeof context?.loadWorldInfo === 'function') {
            if (typeof context.saveWorldInfo !== 'function')
                missing.push('saveWorldInfo');
        }
        else if (typeof globals.createOrReplaceWorldbook !== 'function' && typeof globals.replaceWorldbook !== 'function') {
            missing.push('saveWorldInfo/createOrReplaceWorldbook/replaceWorldbook');
        }
    }
    if (kind === 'persona' && typeof globals.createOrReplacePersona !== 'function' && typeof context?.createOrReplacePersona !== 'function') {
        missing.push('createOrReplacePersona');
    }
    if (kind === 'preset') {
        const manager = context?.getPresetManager?.('openai');
        if (typeof manager?.savePreset !== 'function')
            missing.push('openai.savePreset');
        if (typeof manager?.selectPreset !== 'function')
            missing.push('openai.selectPreset');
    }
    if (kind === 'regex' && typeof globals.replaceTavernRegexes !== 'function')
        missing.push('replaceTavernRegexes');
    return missing;
}
async function characterRoundtrip() {
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
    let cleanupError = null;
    try {
        await globals.createOrReplaceCharacter(tempName, original, { render: 'none' });
        copiedExtensions = Boolean((await globals.getCharacter(tempName))?.extensions);
    }
    finally {
        try {
            await globals.deleteCharacter(tempName, { delete_chats: false });
        }
        catch (error) {
            cleanupError = error instanceof Error ? error.message : String(error);
            console.error('[TavernRoamer self-check] character cleanup failed', { tempName, cleanupError });
        }
    }
    return { supported, selected: true, tempName, copiedExtensions, cleanupError };
}
function chatReadMissing() {
    const globals = getTavernGlobals();
    return ['getChatMessages', 'getVariables'].filter(name => typeof globals[name] !== 'function');
}
function eventDiagnostics() {
    const globals = getTavernGlobals();
    return {
        missing: typeof globals.eventOn === 'function' ? [] : ['eventOn'],
        chatChanged: globals.tavern_events?.CHAT_CHANGED ?? 'chat_id_changed（fallback）',
        generationEnded: globals.tavern_events?.GENERATION_ENDED ?? globals.tavern_events?.MESSAGE_RECEIVED ?? 'generation_ended（fallback）'
    };
}
function chatReplaceMissing() {
    return typeof getTavernGlobals().setChatMessages === 'function' ? [] : ['setChatMessages'];
}
async function setChatMessages(messages) {
    const api = getTavernGlobals().setChatMessages;
    if (typeof api !== 'function')
        throw new Error('setChatMessages API is unavailable');
    await api(messages, { refresh: 'none' });
}
function pullMissing() {
    const globals = getTavernGlobals();
    const context = getSillyTavernContext();
    const missing = ['openCharacterChat', 'selectCharacterById'].filter(name => typeof context?.[name] !== 'function');
    if (!Array.isArray(context?.characters))
        missing.push('characters');
    if (typeof globals.insertOrAssignVariables !== 'function')
        missing.push('insertOrAssignVariables');
    if (typeof globals.createOrReplaceCharacter !== 'function')
        missing.push('createOrReplaceCharacter');
    return missing;
}

;// ./src/tavern/factory.ts






function createTavernServices() {
    return {
        shell: createTavernShell(),
        chatSync: createChatSyncAdapter(),
        chatPull: createTavernPullAdapter(),
        environment: createEnvironmentAdapter(),
        capabilities: detectTavernCapabilities(),
        diagnostics: createTavernDiagnostics()
    };
}

;// ./src/tavern.ts
/* unused harmony import specifier */ var tavern_createTavernServices;


/** Compatibility façade. New composition code should use createTavernServices. */
function createTavernApi() {
    const services = tavern_createTavernServices();
    const adapter = { ...services.chatSync, ...services.environment };
    return { ...services.shell, getChatAdapter: () => adapter };
}


;// ./src/ui/formatters.ts
function statusPill(status) {
    switch (status) {
        case 'synced': return { label: '已是最新', tone: 'green' };
        case 'remote_available': return { label: '雲端已有版本', tone: 'yellow' };
        case 'newer_remote': return { label: '雲端有新版', tone: 'yellow' };
        case 'local_dirty': return { label: '本地有未上傳變更', tone: 'orange' };
        case 'conflict': return { label: '雙方皆有變更', tone: 'red' };
        case 'remote_missing': return { label: '雲端版本遺失', tone: 'red' };
        case 'remote_mismatch': return { label: '版本狀態異常', tone: 'red' };
        case 'check_failed': return { label: '無法核對雲端', tone: 'grey' };
        case 'untracked': return { label: '尚未同步', tone: 'grey' };
        case 'not_connected': return { label: '未連線', tone: 'grey' };
        default: return { label: '尚未核對', tone: 'grey' };
    }
}
function formatPendingLabel(count) {
    if (!Number.isFinite(count) || count <= 0)
        return { text: '無', visible: false, tone: 'normal' };
    return { text: `待傳 ${Math.floor(count)} 筆`, visible: true, tone: 'warn' };
}
function formatAutoSyncLabel(settings) {
    return settings.autoSyncEnabled ? `每 ${settings.autoSyncEveryN} 則` : '已停用';
}
function progressRatioLabel(settled, total) {
    return `${settled}/${total}`;
}
function uploadCompletionMessage(op, states) {
    const isUploadOperation = op === 'upload' || op === 'backup';
    return isUploadOperation && states.length > 0 && states.every(state => state === 'done')
        ? '全部檔案上傳完成'
        : null;
}
function summarizeProgress(states) {
    if (states.length === 0)
        return { label: '尚未開始', tone: 'neutral', finished: false };
    if (states.some(state => state === 'pending' || state === 'active')) {
        return { label: '正在處理', tone: 'running', finished: false };
    }
    const failed = states.filter(state => state === 'error' || state === 'aborted').length;
    const done = states.filter(state => state === 'done').length;
    const skipped = states.filter(state => state === 'skipped').length;
    const queued = states.filter(state => state === 'queued').length;
    const warnings = states.filter(state => state === 'warning').length;
    if (failed > 0 && done + skipped > 0)
        return { label: `部分完成，${failed} 項未完成`, tone: 'warning', finished: true };
    if (failed > 0)
        return { label: `操作失敗，${failed} 項未完成`, tone: 'error', finished: true };
    if (queued > 0)
        return {
            label: done + skipped > 0 ? `部分完成，${queued} 項等待補傳` : `${queued} 項等待補傳`,
            tone: 'warning',
            finished: true
        };
    if (warnings > 0)
        return { label: `部分完成，${warnings} 項尚待核對`, tone: 'warning', finished: true };
    if (done > 0) {
        return { label: skipped > 0 ? `操作完成，${skipped} 項略過` : '全部完成', tone: 'success', finished: true };
    }
    return { label: '沒有可處理的項目', tone: 'neutral', finished: true };
}

;// ./src/ui/html.ts
const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ESCAPE_MAP[char] ?? char);
}
function escapeAttribute(value) {
    return escapeHtml(value);
}

;// ./src/ui/styles.ts
function injectStyle(hostDocument) {
    const existingStyle = hostDocument.querySelector('#tavern-roamer-style');
    const style = existingStyle ?? hostDocument.createElement('style');
    style.id = 'tavern-roamer-style';
    style.textContent = `
    /* 預設繼承酒館主題；外觀覆寫僅作用於本面板。 */
    #tavern-roamer-panel {
      --tr-text: var(--SmartThemeBodyColor, #e7e9ef);
      --tr-background: var(--SmartThemeBlurTintColor, #181a22);
      --tr-accent-base: var(--SmartThemeQuoteColor, #8aa8ff);
      --tr-accent: var(--tr-accent-source, var(--tr-accent-base));
      --tr-surface-strength: 6%;
      --tr-border-strength: 16%;
      --tr-surface: color-mix(in srgb, currentColor var(--tr-surface-strength), transparent);
      --tr-border: color-mix(in srgb, currentColor var(--tr-border-strength), transparent);
      --tr-c-green: #5bbd7a;
      --tr-c-yellow: #d6b34a;
      --tr-c-orange: #d98a4a;
      --tr-c-red: #df7474;
      margin: 0;
      font-size: 14px;
      line-height: 1.5;
      color: var(--tr-text);
    }
    #tavern-roamer-panel[data-appearance-mode="light"] {
      --tr-text: #273244;
      --tr-background: #f7f8fb;
      --tr-accent-base: #4e6cce;
      --tr-c-green: #237340;
      --tr-c-yellow: #806000;
      --tr-c-orange: #995010;
      --tr-c-red: #b33232;
      color-scheme: light;
    }
    #tavern-roamer-panel[data-appearance-mode="dark"] {
      --tr-text: #e7e9ef;
      --tr-background: #181c26;
      --tr-accent-base: #8aa8ff;
      color-scheme: dark;
    }
    #tavern-roamer-panel[data-appearance-tone="soft"] { --tr-surface-strength: 3%; --tr-border-strength: 10%; }
    #tavern-roamer-panel[data-appearance-tone="vivid"] { --tr-surface-strength: 11%; --tr-border-strength: 28%; }
    #tavern-roamer-panel[data-appearance-mode="light"] > .inline-drawer,
    #tavern-roamer-panel[data-appearance-mode="dark"] > .inline-drawer {
      background: var(--tr-background);
      color: var(--tr-text);
      padding: 12px;
      border-radius: 10px;
    }
    #tavern-roamer-panel[data-appearance-mode="light"] > .tr-modal,
    #tavern-roamer-panel[data-appearance-mode="dark"] > .tr-modal { padding: 0; }
    #tavern-roamer-panel[data-appearance-mode="light"] .inline-drawer-header,
    #tavern-roamer-panel[data-appearance-mode="dark"] .inline-drawer-header { background: transparent; color: inherit; }
    #tavern-roamer-panel .menu_button,
    #tavern-roamer-panel .text_pole {
      color: var(--tr-text);
      background: var(--tr-surface);
      border: 1px solid var(--tr-border);
      text-shadow: none;
    }
    #tavern-roamer-panel select.text_pole option { background: var(--tr-background); color: var(--tr-text); }
    #tavern-roamer-panel input { accent-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-appearance-controls { display: grid; gap: 14px; }
    #tavern-roamer-panel .tr-appearance-controls > .tr-field select { width: 100%; min-height: 42px; }
    #tavern-roamer-panel .tr-accent-presets { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-swatch { display: inline-flex; align-items: center; gap: 8px; }
    #tavern-roamer-panel .tr-swatch i { width: 16px; height: 16px; border-radius: 50%; background: var(--tr-swatch); border: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-color-field { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
    #tavern-roamer-panel input[type="color"] { width: 52px; height: 38px; padding: 3px; border: 1px solid var(--tr-border); border-radius: 6px; background: var(--tr-surface); cursor: pointer; }
    #tavern-roamer-panel .tr-preview-statuses { display: flex; flex-wrap: wrap; gap: 12px; }
    #tavern-roamer-panel .tr-appearance-preview .tr-primary:disabled { opacity: 1; cursor: default; }
    #tavern-roamer-panel [data-field="appearance-feedback"] { margin: 0; }
    #tavern-roamer-panel [data-field="appearance-feedback"]:empty { display: none; }
    #tavern-roamer-panel .tr-body {
      display: grid;
      gap: 14px;
      padding: 8px 0 2px;
    }
    /* SillyTavern themes may give .menu_button a fixed square width. Keep this
       panel's text actions horizontal and let their labels determine the width. */
    #tavern-roamer-panel .menu_button {
      flex: 0 0 auto;
      width: auto !important;
      min-width: max-content;
      max-width: 100%;
      white-space: nowrap;
      writing-mode: horizontal-tb;
    }
    #tavern-roamer-panel .menu_button > span {
      white-space: nowrap;
    }
    #tavern-roamer-panel a.menu_button { text-decoration: none; }
    #tavern-roamer-panel .tr-help-link {
      width: fit-content;
      color: color-mix(in srgb, var(--tr-accent) 82%, var(--tr-text));
      font-weight: 600;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    #tavern-roamer-panel .tr-help-link:is(:hover, :focus-visible) { color: var(--tr-accent); }
    #tavern-roamer-panel .tr-help-link > i { margin-left: 3px; font-size: .8em; }
    #tavern-roamer-panel .tr-screen {
      display: grid;
      gap: 24px;
      min-height: 0;
    }
    #tavern-roamer-panel .tr-screen[hidden] { display: none !important; }
    #tavern-roamer-panel :is(.tr-home-actions, .tr-connect-guide, .tr-current-card, .tr-home-progress-lock)[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }
    #tavern-roamer-panel .tr-current-card,
    #tavern-roamer-panel .tr-summary-card {
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-muted,
    #tavern-roamer-panel .tr-summary-card span { opacity: .84; }
    #tavern-roamer-panel .tr-connection-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--tr-border); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tr-border) 70%, transparent); }
    #tavern-roamer-panel .tr-connection-dot.is-connected { background: var(--tr-c-green); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tr-c-green) 18%, transparent); }
    #tavern-roamer-panel .tr-current-card { display: grid; min-width: 0; overflow: hidden; }
    #tavern-roamer-panel [data-field="home-current-content"] { min-width: 0; }
    #tavern-roamer-panel .tr-current-main {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      min-width: 0;
      padding: 18px;
    }
    #tavern-roamer-panel .tr-current-avatar {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--tr-accent) 18%, var(--tr-surface));
      color: var(--tr-accent);
      font-size: 20px;
      font-weight: 700;
    }
    #tavern-roamer-panel .tr-current-details { display: grid; gap: 3px; min-width: 0; }
    #tavern-roamer-panel .tr-current-details > b { font-size: 16px; }
    #tavern-roamer-panel .tr-current-filename { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .84; }
    #tavern-roamer-panel .tr-current-status { display: grid; justify-items: start; gap: 7px; margin-top: 5px; }
    #tavern-roamer-panel .tr-current-meta { display: flex; flex-wrap: wrap; gap: 3px 8px; min-width: 0; margin: 0; font-size: 12px; opacity: .84; }
    #tavern-roamer-panel .tr-current-meta > span + span::before { content: '·'; margin-right: 8px; }
    #tavern-roamer-panel .tr-current-cta { display: grid; justify-items: stretch; gap: 4px; min-width: 0; }
    #tavern-roamer-panel .tr-current-action { display: grid; justify-items: stretch; gap: 4px; }
    #tavern-roamer-panel .tr-current-action small { max-width: 180px; text-align: center; opacity: .84; }
    #tavern-roamer-panel .tr-current-meta [data-field="queue-segment"] { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
    #tavern-roamer-panel .tr-current-meta .tr-queue-flush { min-height: 0; margin: 0; padding: 2px 8px; font-size: 12px; }
    #tavern-roamer-panel .tr-current-feedback { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-current-feedback:empty { display: none; }
    #tavern-roamer-panel .tr-current-warning { display: flex; align-items: flex-start; gap: 7px; max-width: 220px; margin: 0; font-size: 13px; }
    #tavern-roamer-panel .tr-current-warning > i { margin-top: .2em; color: var(--tr-c-orange); }
    #tavern-roamer-panel .tr-callout[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-current-empty { display: flex; align-items: center; gap: 7px; max-width: 210px; margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-summary-card { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
    #tavern-roamer-panel .tr-summary-card { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #tavern-roamer-panel .tr-cloud-filename { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-summary-card > div { display: grid; gap: 5px; padding: 14px 16px; border-right: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-summary-card > div:nth-child(even) { border-right: 0; }
    #tavern-roamer-panel .tr-home-actions { display: grid; gap: 18px; }
    #tavern-roamer-panel .tr-connect-guide {
      display: grid;
      gap: 16px;
      padding: 18px;
      border: 1px solid color-mix(in srgb, var(--tr-accent) 34%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
    }
    #tavern-roamer-panel .tr-connect-guide-head { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; align-items: start; }
    #tavern-roamer-panel .tr-connect-guide-head > i { margin-top: 3px; color: var(--tr-accent); font-size: 22px; }
    #tavern-roamer-panel .tr-connect-guide h3 { margin: 0; font-size: 18px; }
    #tavern-roamer-panel .tr-connect-guide p { margin: 3px 0 0; opacity: .84; }
    #tavern-roamer-panel .tr-connect-steps { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    #tavern-roamer-panel .tr-connect-steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 10px; }
    #tavern-roamer-panel .tr-connect-steps li > span { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--tr-border); border-radius: 50%; background: var(--tr-surface); font-weight: 700; }
    #tavern-roamer-panel .tr-connect-steps li > div { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
    #tavern-roamer-panel .tr-connect-guide > .menu_button { justify-self: start; }
    #tavern-roamer-panel .tr-task-section { display: grid; gap: 9px; }
    #tavern-roamer-panel .tr-task-section-head { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-task-section-head h3 { margin: 0; font-size: 16px; }
    #tavern-roamer-panel .tr-task-section-head p { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-task-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    #tavern-roamer-panel .tr-task-card {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      padding: 15px 16px;
      min-height: 76px;
      text-align: left;
      color: inherit;
      background: var(--tr-surface);
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-task-card:hover { border-color: var(--tr-accent); background: color-mix(in srgb, var(--tr-accent) 12%, transparent); }
    #tavern-roamer-panel :is(.tr-task-card, .menu_button, .tr-cloud-role, .tr-cloud-pull, .text_pole, input, summary):focus-visible,
    #tavern-roamer-panel .tr-choice-row:focus-within {
      outline: 3px solid var(--tr-accent);
      outline-offset: 3px;
    }
    #tavern-roamer-panel .tr-task-card > i:first-child { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 9px; background: color-mix(in srgb, var(--tr-accent) 18%, transparent); color: var(--tr-accent); font-size: 17px; }
    #tavern-roamer-panel .tr-task-card span { display: grid; gap: 3px; }
    #tavern-roamer-panel .tr-task-card b { font-size: 14px; }
    #tavern-roamer-panel .tr-task-card small { opacity: .84; font-size: 12px; }
    #tavern-roamer-panel .tr-environment-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-secondary-task { min-height: 40px; }
    #tavern-roamer-panel .tr-home-progress-lock { margin: -4px 0 0; padding: 9px 12px; border-radius: 8px; background: color-mix(in srgb, var(--tr-c-yellow) 12%, transparent); color: var(--tr-text); }
    #tavern-roamer-panel .tr-operation-banner {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px 12px;
      padding: 11px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--tr-accent) 34%, transparent);
      background: color-mix(in srgb, var(--tr-accent) 11%, transparent);
    }
    #tavern-roamer-panel .tr-operation-summary { display: flex; align-items: center; gap: 8px; min-width: 0; }
    #tavern-roamer-panel .tr-operation-summary b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tavern-roamer-panel .tr-operation-banner > .menu_button { grid-column: 2; grid-row: 1; }
    #tavern-roamer-panel .tr-progress-resume-bar { grid-column: 1 / -1; grid-row: 2; height: 4px; }
    #tavern-roamer-panel .tr-operation-banner[hidden],
    #tavern-roamer-panel .tr-preview-retry[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-step-heading { display: grid; gap: 4px; }
    #tavern-roamer-panel .tr-step-heading h2 { margin: 2px 0 0; font-size: 21px; }
    /* 頁面標題只接受程式化焦點供讀屏宣告，不是操作控制，不顯示按鈕式焦點框。 */
    #tavern-roamer-panel .tr-step-heading h2:focus { outline: none; }
    #tavern-roamer-panel .tr-step-heading p { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-step-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .86; }
    #tavern-roamer-panel .tr-step-dots { display: flex; gap: 5px; }
    #tavern-roamer-panel .tr-step-dots i { width: 26px; height: 4px; border-radius: 99px; background: var(--tr-border); }
    #tavern-roamer-panel .tr-step-dots i.is-active { background: var(--tr-accent); }
    #tavern-roamer-panel .tr-callout {
      padding: 11px 14px;
      border: 0;
      border-left: 3px solid color-mix(in srgb, var(--tr-accent) 72%, var(--tr-text));
      border-radius: 0 8px 8px 0;
      background: color-mix(in srgb, var(--tr-accent) 9%, transparent);
    }
    #tavern-roamer-panel .tr-callout.tr-danger {
      border-left-color: color-mix(in srgb, var(--tr-c-orange) 78%, var(--tr-text));
      background: color-mix(in srgb, var(--tr-c-orange) 10%, transparent);
    }
    #tavern-roamer-panel .tr-inline-note {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      align-items: start;
      gap: 8px;
      padding: 10px 12px;
      border-left: 3px solid color-mix(in srgb, var(--tr-accent) 68%, var(--tr-text));
      border-radius: 0 7px 7px 0;
      background: color-mix(in srgb, var(--tr-accent) 7%, transparent);
    }
    #tavern-roamer-panel .tr-inline-note > i { margin-top: .22em; color: var(--tr-accent); }
    #tavern-roamer-panel .tr-danger-button { border-color: color-mix(in srgb, var(--tr-c-red) 50%, var(--tr-border)); }
    #tavern-roamer-panel .tr-danger-button:not(:disabled):hover { background: color-mix(in srgb, var(--tr-c-red) 15%, transparent); }
    #tavern-roamer-panel .tr-step-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-step-footer > div { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; justify-content: flex-end; }
    #tavern-roamer-panel .tr-step-footer [hidden] { display: none !important; }
    #tavern-roamer-panel .tr-step-footer > div:empty { display: none; }
    #tavern-roamer-panel .tr-choice-list {
      display: grid;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-choice-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      border: 0;
      border-radius: 0;
      background: transparent;
      cursor: pointer;
      transition: background-color 160ms ease;
    }
    #tavern-roamer-panel .tr-choice-row + .tr-choice-row { border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-choice-row:is(:hover, :focus-within) { background: color-mix(in srgb, var(--tr-accent) 9%, transparent); }
    #tavern-roamer-panel .tr-choice-row:focus-within { outline-offset: -3px; }
    #tavern-roamer-panel .tr-choice-row span { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-choice-row small { opacity: .84; }
    #tavern-roamer-panel .tr-choice-title { display: flex !important; align-items: center; flex-wrap: wrap; gap: 6px !important; }
    #tavern-roamer-panel .tr-choice-badge { padding: 1px 7px; border-radius: 999px; color: var(--tr-accent); background: color-mix(in srgb, var(--tr-accent) 12%, transparent); font-size: 11px; font-style: normal; font-weight: 700; }
    #tavern-roamer-panel .tr-choice-row.is-required {
      box-shadow: inset 3px 0 color-mix(in srgb, var(--tr-c-orange) 72%, var(--tr-text));
      background: color-mix(in srgb, var(--tr-c-orange) 6%, transparent);
    }
    #tavern-roamer-panel .tr-choice-row.is-required:is(:hover, :focus-within) {
      background: color-mix(in srgb, var(--tr-c-orange) 10%, transparent);
    }
    #tavern-roamer-panel .tr-choice-row.is-required .tr-choice-badge { color: var(--tr-c-orange); background: color-mix(in srgb, var(--tr-c-orange) 13%, transparent); }
    #tavern-roamer-panel .tr-choice-version { overflow-wrap: anywhere; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
    #tavern-roamer-panel .tr-choice-row > i { color: var(--tr-c-green); }
    #tavern-roamer-panel .tr-choice-row input:not(:checked) ~ i { visibility: hidden; }
    #tavern-roamer-panel .tr-restore-preview,
    #tavern-roamer-panel .tr-preview-group { display: grid; gap: 8px; }
    #tavern-roamer-panel .tr-preview-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) max-content; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--tr-c-green) 10%, transparent); }
    #tavern-roamer-panel .tr-preview-row > span { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-preview-filename {
      opacity: .84;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-preview-row.is-skipped { background: var(--tr-surface); }
    #tavern-roamer-panel .tr-restore-toolbar {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(140px, .55fr) auto;
      align-items: end;
      gap: 10px;
    }
    #tavern-roamer-panel .tr-restore-toolbar .tr-field { margin: 0; }
    #tavern-roamer-panel .tr-restore-toolbar .menu_button { min-height: 44px; }
    #tavern-roamer-panel .tr-restore-point-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-restore-point-actions .menu_button,
    #tavern-roamer-panel .tr-restore-selection .menu_button { min-width: 0; min-height: 44px; white-space: normal; }
    #tavern-roamer-panel .tr-restore-point-actions .menu_button > span,
    #tavern-roamer-panel .tr-restore-selection .menu_button > span { white-space: normal; }
    #tavern-roamer-panel .tr-restore-selection {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px 16px;
      padding: 10px 12px;
      border: 1px solid var(--tr-border);
      border-radius: 9px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-selection[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-restore-selection label { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
    #tavern-roamer-panel .tr-restore-selection [data-field="restore-selection-count"] { flex: 1 1 130px; }
    #tavern-roamer-panel .tr-restore-advanced { position: relative; }
    #tavern-roamer-panel .tr-restore-advanced summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; opacity: .82; }
    #tavern-roamer-panel .tr-restore-advanced[open] { flex-basis: 100%; display: grid; gap: 8px; }
    #tavern-roamer-panel .tr-restore-point-feedback { margin: 0; min-height: 1.5em; }
    #tavern-roamer-panel .tr-restore-point-feedback:empty { display: none; }
    #tavern-roamer-panel .tr-restore-cleanup-card,
    #tavern-roamer-panel .tr-restore-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-cleanup-card > div:first-child,
    #tavern-roamer-panel .tr-restore-detail-head > div:first-child { display: grid; gap: 3px; }
    #tavern-roamer-panel .tr-restore-cleanup-card small,
    #tavern-roamer-panel .tr-restore-detail-head small { opacity: .78; }
    #tavern-roamer-panel .tr-restore-chat-list { display: grid; gap: 8px; margin-top: 12px; }
    #tavern-roamer-panel .tr-restore-chat-card {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content auto;
      align-items: center;
      gap: 14px;
      min-height: 66px;
      padding: 12px 14px;
      color: inherit;
      text-align: left;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-restore-chat-card:hover { border-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-restore-chat-card:focus-visible { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-chat-main,
    #tavern-roamer-panel .tr-restore-chat-meta { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-restore-chat-main b { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-restore-chat-main small,
    #tavern-roamer-panel .tr-restore-chat-meta small { opacity: .74; }
    #tavern-roamer-panel .tr-restore-chat-main em { color: var(--tr-c-orange); font-size: 11px; font-style: normal; }
    #tavern-roamer-panel .tr-restore-chat-meta { text-align: right; white-space: nowrap; }
    #tavern-roamer-panel .tr-back-inline { width: fit-content; min-height: 44px; margin-bottom: 10px; }
    #tavern-roamer-panel .tr-restore-detail-head h3 { margin: 0; overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-restore-detail-select { padding: 8px 2px; }
    #tavern-roamer-panel .tr-restore-detail-select label { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
    #tavern-roamer-panel .tr-restore-point-list,
    #tavern-roamer-panel .tr-restore-batch,
    #tavern-roamer-panel .tr-restore-files { display: grid; gap: 10px; }
    #tavern-roamer-panel .tr-restore-batch {
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-restore-batch-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    #tavern-roamer-panel .tr-restore-batch-head > div { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-restore-batch-head small { opacity: .78; }
    #tavern-roamer-panel .tr-restore-technical { position: relative; flex: 0 0 auto; }
    #tavern-roamer-panel .tr-restore-technical summary {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 44px;
      padding: 0 8px;
      border-radius: 7px;
      opacity: .78;
      cursor: pointer;
      user-select: none;
    }
    #tavern-roamer-panel .tr-restore-technical summary:hover { opacity: 1; background: var(--tr-background); }
    #tavern-roamer-panel .tr-restore-technical summary:focus-visible { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-technical-content {
      display: grid;
      gap: 10px;
      margin-top: 8px;
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 8px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-batch-head .tr-restore-technical[open] { flex-basis: 100%; }
    #tavern-roamer-panel .tr-restore-technical-row { display: grid; grid-template-columns: minmax(108px, .3fr) minmax(0, 1fr); gap: 8px 14px; align-items: baseline; }
    #tavern-roamer-panel .tr-restore-technical-row small { opacity: .72; }
    #tavern-roamer-panel .tr-restore-technical-row code { overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    #tavern-roamer-panel .tr-restore-technical-group { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-restore-issues { display: flex; flex-wrap: wrap; gap: 6px; }
    #tavern-roamer-panel .tr-restore-issues span { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: 999px; color: var(--tr-c-orange); background: color-mix(in srgb, var(--tr-c-orange) 12%, transparent); font-size: 11px; }
    #tavern-roamer-panel .tr-restore-file {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      min-height: 54px;
      padding: 10px 12px;
      border: 1px solid var(--tr-border);
      border-radius: 8px;
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-restore-file:hover { border-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-restore-file.is-empty { cursor: default; opacity: .78; }
    #tavern-roamer-panel .tr-restore-file.is-empty:hover { border-color: var(--tr-border); }
    #tavern-roamer-panel .tr-restore-file:focus-within { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-file-main { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-restore-file-main > span { overflow-wrap: anywhere; font-size: 12px; line-height: 1.4; opacity: .82; }
    #tavern-roamer-panel .tr-progress-state { display: flex; align-items: center; gap: 10px; font-size: 17px; }
    #tavern-roamer-panel .tr-state-success { color: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-state-warning { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-state-error { color: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-state-neutral { opacity: .8; }
    #tavern-roamer-panel .tr-section {
      display: grid;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-section-title {
      font-weight: 600;
      opacity: .82;
      border-bottom: 1px solid var(--tr-border);
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
      opacity: .84;
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
    #tavern-roamer-panel .tr-tone-red { --tr-tone: var(--tr-c-red, #d05a5a); }
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
      border: 1px solid var(--tr-border);
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
    #tavern-roamer-panel .tr-self-check-panel {
      display: grid;
      gap: 12px;
      margin-top: 4px;
      padding: 14px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-self-check-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
    }
    #tavern-roamer-panel .tr-self-check-head > div:first-child { display: grid; gap: 4px; }
    #tavern-roamer-panel .tr-self-check-head small { opacity: .84; max-width: 620px; }
    #tavern-roamer-panel .tr-self-check-results,
    #tavern-roamer-panel .tr-check-groups { display: grid; gap: 10px; }
    #tavern-roamer-panel .tr-check-empty { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-check-running,
    #tavern-roamer-panel .tr-check-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-accent) 28%, transparent);
    }
    #tavern-roamer-panel .tr-check-running { justify-content: flex-start; }
    #tavern-roamer-panel .tr-check-running > span { display: flex; justify-content: space-between; gap: 12px; width: 100%; }
    #tavern-roamer-panel .tr-check-summary-copy { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-check-summary-copy small { font-size: 12px; opacity: .86; }
    #tavern-roamer-panel .tr-check-summary-success { border-color: color-mix(in srgb, var(--tr-c-green, #5bbd7a) 34%, transparent); }
    #tavern-roamer-panel .tr-check-summary-warning { border-color: color-mix(in srgb, var(--tr-c-orange, #d98a4a) 38%, transparent); }
    #tavern-roamer-panel .tr-check-summary-error { border-color: color-mix(in srgb, var(--tr-c-red, #d05a5a) 38%, transparent); }
    #tavern-roamer-panel .tr-check-group { display: grid; gap: 6px; }
    #tavern-roamer-panel .tr-check-group h3 { margin: 0; font-size: 14px; opacity: .86; }
    #tavern-roamer-panel .tr-check-group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
    #tavern-roamer-panel .tr-check-row {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
      padding: 9px 10px;
      border-radius: 7px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-check-icon { padding-top: 1px; text-align: center; }
    #tavern-roamer-panel .tr-check-pass .tr-check-icon { color: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-check-fail .tr-check-icon { color: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-check-blocked .tr-check-icon { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-check-not_applicable .tr-check-icon { opacity: .58; }
    #tavern-roamer-panel .tr-check-copy { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-check-copy small { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-check-remediation { opacity: .86; }
    #tavern-roamer-panel .tr-check-action { align-self: center; }
    #tavern-roamer-panel .tr-check-details { grid-column: 2 / -1; font-size: 12px; opacity: .86; }
    #tavern-roamer-panel .tr-check-details summary { cursor: pointer; }
    #tavern-roamer-panel .tr-check-details pre {
      margin: 6px 0 0;
      padding: 8px;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
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
      border: 1px solid var(--tr-border);
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
      opacity: .84;
      font-variant-numeric: tabular-nums;
    }
    #tavern-roamer-panel .tr-progressbar {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--tr-border);
    }
    #tavern-roamer-panel .tr-progressbar > i {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--tr-accent);
      transition: width .2s ease;
    }
    #tavern-roamer-panel .tr-progressbar-warning > i { background: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-progressbar-error > i { background: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-progressbar-neutral > i { background: var(--tr-c-grey, #9aa0a6); }
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
    #tavern-roamer-panel .tr-upload-complete {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 4px;
      padding: 10px 12px;
      border-radius: 7px;
      color: var(--tr-c-green, #5bbd7a);
      background: color-mix(in srgb, var(--tr-c-green, #5bbd7a) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-c-green, #5bbd7a) 28%, transparent);
    }
    #tavern-roamer-panel .tr-row-detail {
      opacity: .86;
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-row-icon { text-align: center; }
    #tavern-roamer-panel .tr-ok { color: var(--tr-c-green, #5bbd7a); font-weight: 700; }
    #tavern-roamer-panel .tr-err { color: var(--tr-c-red, #d05a5a); font-weight: 700; }
    #tavern-roamer-panel .tr-abort { color: var(--tr-c-orange, #d98a4a); font-weight: 700; }
    #tavern-roamer-panel .tr-queued { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-dot { opacity: .5; }
    #tavern-roamer-panel .tr-retry {
      padding: 2px 8px;
      font-size: 12px;
    }
    #tavern-roamer-panel .tr-cloud {
      display: grid;
      gap: 12px;
    }
    #tavern-roamer-panel .tr-cloud[hidden] { display: none; }
    #tavern-roamer-panel .tr-cloud-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 2px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-cloud-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-cloud-list > li {
      min-width: 0;
    }
    #tavern-roamer-panel .tr-cloud-list > li + li { border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-cloud-role {
      width: 100% !important;
      min-width: 0;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      text-align: left;
    }
    #tavern-roamer-panel .tr-cloud-role > span {
      min-width: 0;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    #tavern-roamer-panel .tr-cloud-role-chevron { opacity: .58; font-size: 12px; }
    #tavern-roamer-panel .tr-cloud-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content max-content;
      gap: 8px;
      align-items: center;
      min-height: 64px;
      padding: 12px 14px;
    }
    #tavern-roamer-panel .tr-cloud-chat-id {
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-cloud-chat-info {
      opacity: .84;
      font-size: 12px;
      white-space: nowrap;
    }
    #tavern-roamer-panel .tr-cloud-empty {
      margin: 0;
      padding: 14px;
      opacity: .84;
    }
    #tavern-roamer-panel .tr-report {
      margin: 0;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 180px;
      padding: 8px;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
      color: var(--tr-text);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-report:empty { display: none; }

    /* 浮動保底：掛到 body（iframe 自身 document）時酒館的元件 class 與主題變數
       不存在，需一組 scoped 保底樣式，只在 .tr-floating 下生效。 */
    #tavern-roamer-panel.tr-floating {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)) !important;
      background: rgba(8, 10, 18, 0.72);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
    }
    #tavern-roamer-panel .tr-modal {
      width: min(1080px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      max-height: calc(100dvh - 48px);
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--tr-border);
      background:
        linear-gradient(180deg, color-mix(in srgb, currentColor 8%, transparent), transparent 140px),
        var(--tr-background);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }
    #tavern-roamer-panel .tr-modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--tr-border);
      cursor: default;
    }
    #tavern-roamer-panel .tr-kicker {
      margin-bottom: 4px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.84;
    }
    #tavern-roamer-panel .tr-title {
      font-size: 22px;
      line-height: 1.1;
    }
    #tavern-roamer-panel .tr-modal-content {
      display: block;
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 16px 20px 20px;
    }
    #tavern-roamer-panel .tr-header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
      min-width: 0;
    }
    #tavern-roamer-panel .tr-connection-button {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0 !important;
      max-width: min(220px, 38vw);
    }
    #tavern-roamer-panel .tr-connection-button > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tavern-roamer-panel .tr-close {
      flex: 0 0 auto;
      min-width: 72px;
      width: auto;
      min-height: 34px;
      justify-content: center;
      padding: 6px 14px;
      white-space: nowrap;
      writing-mode: horizontal-tb;
      line-height: 1.2;
    }
    #tavern-roamer-panel.tr-floating .menu_button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--tr-border);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: inherit;
      background: var(--tr-surface);
      font-size: 13px;
      min-height: 42px;
    }
    #tavern-roamer-panel.tr-floating .text_pole {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid var(--tr-border);
      padding: 6px 8px;
      background: var(--tr-surface);
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
    #tavern-roamer-panel .menu_button:is(:hover, [aria-pressed="true"], .tr-primary) {
      background: color-mix(in srgb, var(--tr-accent) 22%, var(--tr-background));
      border-color: var(--tr-accent);
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      touch-action: manipulation;
      transition: background-color 160ms ease;
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role:is(:hover, :focus-visible) {
      border-color: transparent;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role:focus-visible { outline-offset: -3px; }
    #tavern-roamer-panel .tr-upload-overview {
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-upload-overview > .tr-summary-card {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    #tavern-roamer-panel .tr-upload-overview [data-field="upload-preview"] {
      display: grid;
      gap: 12px;
      padding: 12px 0 16px;
      border-top: 1px solid var(--tr-border);
    }
    #tavern-roamer-panel .tr-upload-overview [data-field="upload-preview"] > :not(.tr-upload-cloud-summary) {
      margin-inline: 16px;
    }
    #tavern-roamer-panel .tr-upload-cloud-summary {
      display: grid;
      gap: 5px;
      min-width: 0;
      padding: 4px 16px;
    }
    #tavern-roamer-panel .tr-upload-cloud-summary > span { opacity: .84; }
    @media (max-width: 640px) {
      #tavern-roamer-panel.tr-floating {
        align-items: flex-start;
        padding: max(12px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)) !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
      }
      #tavern-roamer-panel .tr-modal {
        flex: 0 0 auto;
        width: 100%;
        max-height: none;
        border-radius: 8px;
      }
      #tavern-roamer-panel .tr-modal-header {
        flex-shrink: 0;
        flex-wrap: wrap;
        align-items: center;
        padding: 12px 14px 10px;
      }
      #tavern-roamer-panel .tr-kicker {
        margin-bottom: 2px;
      }
      #tavern-roamer-panel .tr-title {
        font-size: 19px;
      }
      #tavern-roamer-panel .tr-close {
        min-width: 64px;
      }
      #tavern-roamer-panel .tr-modal-content {
        flex: 0 0 auto;
        overflow: visible;
        padding: 12px 14px 16px;
      }
      #tavern-roamer-panel .tr-task-grid,
      #tavern-roamer-panel .tr-summary-card { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-summary-card > div { border-right: 0; border-bottom: 1px solid var(--tr-border); }
      #tavern-roamer-panel .tr-summary-card > div:last-child { border-bottom: 0; }
      #tavern-roamer-panel .tr-current-main { grid-template-columns: 48px minmax(0, 1fr); padding: 16px; }
      #tavern-roamer-panel .tr-current-avatar { width: 48px; height: 48px; }
      #tavern-roamer-panel .tr-current-cta { grid-column: 1 / -1; width: 100%; }
      #tavern-roamer-panel .tr-current-cta > .menu_button,
      #tavern-roamer-panel .tr-current-action,
      #tavern-roamer-panel .tr-current-action > .menu_button { width: 100% !important; }
      #tavern-roamer-panel .tr-current-action small,
      #tavern-roamer-panel .tr-current-warning { max-width: none; }
      #tavern-roamer-panel .tr-preview-row { grid-template-columns: 20px minmax(0, 1fr); }
      #tavern-roamer-panel .tr-preview-row > small { grid-column: 2; }
      #tavern-roamer-panel .tr-header-actions .tr-icon-button span { display: none; }
      #tavern-roamer-panel .tr-cloud-chat-row {
        grid-template-columns: minmax(0, 1fr) max-content;
      }
      #tavern-roamer-panel .tr-cloud-chat-info {
        grid-column: 1 / -1;
        grid-row: 2;
        white-space: normal;
      }
      #tavern-roamer-panel .tr-self-check-head,
      #tavern-roamer-panel .tr-check-summary { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-toolbar { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-restore-cleanup-card,
      #tavern-roamer-panel .tr-restore-detail-head { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-chat-card { grid-template-columns: minmax(0, 1fr) auto; }
      #tavern-roamer-panel .tr-restore-chat-meta { grid-column: 1; grid-row: 2; text-align: left; white-space: normal; }
      #tavern-roamer-panel .tr-restore-chat-card > i { grid-column: 2; grid-row: 1 / 3; }
      #tavern-roamer-panel .tr-restore-file { grid-template-columns: auto minmax(0, 1fr); }
      #tavern-roamer-panel .tr-restore-batch-head { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-technical { width: 100%; }
      #tavern-roamer-panel .tr-restore-technical summary { width: fit-content; }
      #tavern-roamer-panel .tr-restore-technical-row { grid-template-columns: 1fr; gap: 2px; }
      #tavern-roamer-panel .tr-check-row { grid-template-columns: 20px minmax(0, 1fr); }
      #tavern-roamer-panel .tr-check-action { grid-column: 2; justify-self: start; }
    }
    @media (max-width: 480px) {
      #tavern-roamer-panel .tr-operation-banner { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-operation-banner > .menu_button { grid-column: 1; grid-row: 3; width: 100% !important; }
      #tavern-roamer-panel .tr-progress-resume-bar { grid-column: 1; grid-row: 2; }
      #tavern-roamer-panel .tr-connect-guide > .menu_button { justify-self: stretch; width: 100% !important; }
      #tavern-roamer-panel .tr-environment-actions { display: grid; grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-environment-actions > .menu_button { width: 100% !important; }
      #tavern-roamer-panel .tr-step-footer {
        flex-wrap: wrap;
        align-items: stretch;
      }
      #tavern-roamer-panel .tr-step-footer > div {
        flex: 1 1 180px;
      }
      #tavern-roamer-panel .tr-step-footer > div > .menu_button {
        width: 100% !important;
      }
      #tavern-roamer-panel .tr-step-footer .menu_button,
      #tavern-roamer-panel .tr-step-footer .menu_button > span {
        min-width: 0;
        min-height: 44px;
        white-space: normal;
        overflow-wrap: anywhere;
      }
    }
    @media (max-width: 360px) {
      #tavern-roamer-panel .tr-header-actions { gap: 6px; }
      #tavern-roamer-panel .tr-connection-button { max-width: 132px; }
      #tavern-roamer-panel .tr-current-main { grid-template-columns: 42px minmax(0, 1fr); gap: 10px; padding: 14px; }
      #tavern-roamer-panel .tr-current-avatar { width: 42px; height: 42px; font-size: 17px; }
      #tavern-roamer-panel .tr-current-meta { display: grid; gap: 2px; }
      #tavern-roamer-panel .tr-current-meta > span + span::before { content: none; }
      #tavern-roamer-panel .tr-step-footer {
        flex-direction: column;
      }
      #tavern-roamer-panel .tr-step-footer > .menu_button,
      #tavern-roamer-panel .tr-step-footer > div {
        width: 100% !important;
      }
      #tavern-roamer-panel .tr-step-footer > div {
        flex-basis: auto;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #tavern-roamer-panel *,
      #tavern-roamer-panel *::before,
      #tavern-roamer-panel *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
      }
    }
  `;
    if (!existingStyle) {
        hostDocument.head.append(style);
    }
}

;// ./src/ui/appearance.ts


const accentPresets = [
    { name: '霧藍', color: '#8aa8ff' },
    { name: '薰衣草', color: '#b39ddb' },
    { name: '薄荷', color: '#66bfa3' },
    { name: '玫瑰', color: '#dc91ab' },
    { name: '琥珀', color: '#d6a64c' }
];
/** Theme overrides stay on the panel; removing them resumes host theme inheritance. */
function applyAppearance(root, value) {
    const appearance = normalizeAppearance(value);
    root.dataset.appearanceMode = appearance.mode;
    root.dataset.appearanceTone = appearance.tone;
    if (appearance.accentColor) {
        root.style.setProperty('--tr-accent-source', appearance.accentColor);
    }
    else {
        root.style.removeProperty('--tr-accent-source');
    }
}

;// ./src/ui/panelHost.ts
function prepareFloatingHost(host, targetWindow) {
    const viewport = targetWindow.visualViewport;
    const fullScreenStyles = floatingHostLayout(viewport?.width ?? targetWindow.innerWidth, viewport?.height ?? targetWindow.innerHeight);
    for (const [property, value] of Object.entries(fullScreenStyles)) {
        const cssProperty = property.startsWith('webkit')
            ? `-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
            : property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        host.style.setProperty(cssProperty, value, 'important');
    }
}
function floatingHostLayout(viewportWidth, viewportHeight) {
    return {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
        width: `${viewportWidth}px`,
        height: `${viewportHeight}px`,
        minWidth: '0',
        minHeight: '0',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: '0',
        border: '0',
        transform: 'none',
        filter: 'none',
        perspective: 'none',
        contain: 'none',
        overflowX: 'hidden',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        webkitOverflowScrolling: 'touch',
        boxSizing: 'border-box',
        zIndex: '40000'
    };
}
function isHtmlElement(value, hostDocument) {
    const HtmlElement = hostDocument.defaultView?.HTMLElement;
    return Boolean(value && HtmlElement && value instanceof HtmlElement);
}
function getFocusableElements(container) {
    const selector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'summary',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    return [...container.querySelectorAll(selector)].filter(element => {
        if (element.closest('[hidden], [aria-hidden="true"]'))
            return false;
        return element.getAttribute('tabindex') !== '-1';
    });
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

;// ./src/ui/selfCheckReport.ts

function summarizeSelfChecks(results) {
    const pass = results.filter(result => result.status === 'pass').length;
    const fail = results.filter(result => result.status === 'fail').length;
    const blocked = results.filter(result => result.status === 'blocked').length;
    const notApplicable = results.filter(result => result.status === 'not_applicable').length;
    if (fail > 0) {
        return { pass, fail, blocked, notApplicable, label: `需要處理 ${fail} 項`, tone: 'error' };
    }
    if (blocked > 0) {
        return { pass, fail, blocked, notApplicable, label: `缺少前置條件 ${blocked} 項`, tone: 'warning' };
    }
    if (results.length > 0) {
        return { pass, fail, blocked, notApplicable, label: '全部正常', tone: 'success' };
    }
    return { pass, fail, blocked, notApplicable, label: '尚未執行', tone: 'neutral' };
}
function renderSelfCheckResultsHtml(results, state) {
    const summary = summarizeSelfChecks(results);
    const progress = state.progress;
    const running = state.running
        ? `<div class="tr-check-running"><i class="fa-solid fa-spinner fa-spin"></i><span><b>${escapeHtml(progress?.currentLabel ?? '準備檢查…')}</b><small>${progress ? `${progress.completed}/${progress.total}` : '0/—'}</small></span></div>`
        : '';
    if (results.length === 0 && !state.running) {
        return `<p class="tr-check-empty">${state.mode === 'advanced' ? '尚未執行進階診斷。請只在專用測試資料上使用。' : '尚未執行快速檢查。'}</p>`;
    }
    const categories = SELF_CHECK_CATEGORY_ORDER
        .map(category => {
        const categoryResults = results.filter(result => result.category === category);
        if (categoryResults.length === 0)
            return '';
        return `<section class="tr-check-group"><h3>${SELF_CHECK_CATEGORY_LABELS[category]}</h3><ul>${categoryResults.map(renderSelfCheckResultRow).join('')}</ul></section>`;
    })
        .join('');
    const copyAction = !state.running && results.length > 0
        ? '<button type="button" class="menu_button tr-check-copy-report" data-self-check-action="copy_report"><i class="fa-solid fa-copy"></i><span>複製診斷報告</span></button>'
        : '';
    return `
    ${running}
    <div class="tr-check-summary tr-check-summary-${summary.tone}">
      <span class="tr-check-summary-copy"><b>${escapeHtml(state.running ? '檢查進行中' : summary.label)}</b><small>通過 ${summary.pass}｜需處理 ${summary.fail}｜待完成 ${summary.blocked}｜不適用 ${summary.notApplicable}</small></span>
      ${copyAction}
    </div>
    <div class="tr-check-groups">${categories}</div>
  `;
}
function buildSelfCheckReport(results) {
    const summary = summarizeSelfChecks(results);
    const environment = {
        generatedAt: new Date().toISOString(),
        origin: globalThis.location?.origin ?? 'unknown',
        userAgent: globalThis.navigator?.userAgent ?? 'unknown'
    };
    const rows = results.map(result => ({
        label: result.label,
        message: result.message,
        remediation: result.remediation,
        technical: JSON.parse(safeSelfCheckDetails(result))
    }));
    return JSON.stringify({ summary, environment, results: rows }, null, 2);
}
const SELF_CHECK_CATEGORY_ORDER = [
    'settings',
    'drive',
    'chat',
    'environment_backup',
    'environment_restore',
    'cloud_chat',
    'autosync',
    'advanced'
];
const SELF_CHECK_CATEGORY_LABELS = {
    settings: '設定',
    drive: 'Google Drive',
    chat: '目前聊天',
    environment_backup: '環境備份',
    environment_restore: '環境還原',
    cloud_chat: '從雲端建立聊天',
    autosync: '自動同步',
    advanced: '進階診斷'
};
function renderSelfCheckResultRow(result) {
    const action = result.action === 'connect_drive' || result.action === 'open_settings'
        ? `<button type="button" class="menu_button tr-check-action" data-self-check-action="${result.action}">${result.action === 'connect_drive' ? '前往連線' : '開啟設定'}</button>`
        : '';
    const remediation = result.remediation
        ? `<small class="tr-check-remediation">${escapeHtml(result.remediation)}</small>`
        : '';
    const technical = safeSelfCheckDetails(result);
    return `
    <li class="tr-check-row tr-check-${result.status}">
      <span class="tr-check-icon">${selfCheckStatusIcon(result.status)}</span>
      <span class="tr-check-copy"><b>${escapeHtml(result.label)}</b><small>${escapeHtml(result.message)}</small>${remediation}</span>
      ${action}
      <details class="tr-check-details"><summary>技術資訊</summary><pre>${escapeHtml(technical)}</pre></details>
    </li>
  `;
}
function selfCheckStatusIcon(status) {
    if (status === 'pass')
        return '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>';
    if (status === 'fail')
        return '<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>';
    if (status === 'blocked')
        return '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
    return '<i class="fa-solid fa-circle-minus" aria-hidden="true"></i>';
}
function safeSelfCheckDetails(result) {
    const payload = redactSensitive({
        id: result.id,
        status: result.status,
        category: result.category,
        safety: result.safety,
        mode: result.mode,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        details: result.details
    });
    try {
        return JSON.stringify(payload, null, 2);
    }
    catch {
        return JSON.stringify({ id: result.id, status: result.status, details: '[無法序列化]' }, null, 2);
    }
}
function redactSensitive(value, key = '') {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('access_token') ||
        normalizedKey === 'token' ||
        normalizedKey === 'googleclientid' ||
        normalizedKey === 'clientid') {
        return '[已遮蔽]';
    }
    if (Array.isArray(value))
        return value.map(item => redactSensitive(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            redactSensitive(childValue, childKey)
        ]));
    }
    return value;
}
// ── 版面 ───────────────────────────────────────────────────────────

;// ./src/ui/environmentPresentation.ts

const ENVIRONMENT_PRESENTATION = {
    character: { label: '角色卡', description: '角色資料與頭像；其他裝置建立聊天所需' },
    world: { label: '世界書', description: '世界書、Lorebook 與角色綁定' },
    persona: { label: 'Persona', description: '使用者 Persona，可能包含個人資料' },
    preset: { label: 'Preset', description: '生成與提示詞預設' },
    regex: { label: 'Regex', description: '全域 Regex 腳本設定' }
};
const ENVIRONMENT_ITEM_ORDER = ENVIRONMENT_ITEM_KINDS;
function environmentPresentation_environmentLabel(kind) {
    return ENVIRONMENT_PRESENTATION[kind].label;
}

;// ./src/ui/environmentSelection.ts


function defaultEnvironmentChoices(selected = true) {
    return ENVIRONMENT_ITEM_ORDER.map(kind => ({ kind, selected }));
}
function renderEnvironmentChoices(group, choices) {
    return `<div class="tr-choice-list" data-environment-group="${escapeAttribute(group)}">${choices.map(choice => {
        const presentation = ENVIRONMENT_PRESENTATION[choice.kind];
        const badge = choice.badge ? `<em class="tr-choice-badge">${escapeHtml(choice.badge)}</em>` : '';
        const latest = choice.latestFilename
            ? `<small class="tr-choice-version">雲端已有：${escapeHtml(choice.latestFilename)}</small>`
            : '';
        return `<label class="tr-choice-row${choice.badge === '必要' ? ' is-required' : ''}${choice.latestFilename ? ' is-available' : ''}"><input data-environment-kind="${choice.kind}" data-environment-group="${escapeAttribute(group)}" type="checkbox" ${choice.selected ? 'checked' : ''} ${choice.disabled ? 'disabled' : ''} /><span><span class="tr-choice-title"><b>${escapeHtml(presentation.label)}</b>${badge}</span><small>${escapeHtml(presentation.description)}</small>${latest}</span><i class="fa-solid fa-check" aria-hidden="true"></i></label>`;
    }).join('')}</div>`;
}
function collectEnvironmentSelection(container, group) {
    if (!container)
        return [];
    const selected = new Set([...container.querySelectorAll(`[data-environment-group="${cssAttributeValue(group)}"][data-environment-kind]`)]
        .filter(input => input.checked && !input.disabled)
        .map(input => input.dataset.environmentKind));
    return ENVIRONMENT_ITEM_ORDER.filter(kind => selected.has(kind));
}
function cssAttributeValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

;// ./src/ui/views/shared.ts

function iconButton(action, icon, label, driveRequired = false, hidden = false) {
    return `<button type="button" class="menu_button menu_button_icon ${driveRequired || action === 'save-appearance' || action === 'save' ? 'tr-primary' : ''}" data-action="${action}" ${driveRequired ? 'data-drive-required' : ''} ${hidden ? 'hidden' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
}
function stepHeading(screen, stage, title, description) {
    return `<div class="tr-step-heading"><div class="tr-step-meta"><span>階段：${stage}</span></div><h2 id="tr-screen-${screen}-title" tabindex="-1">${title}</h2><p>${description}</p></div>`;
}
function stepFooter(back, primary) {
    return `<div class="tr-step-footer"><button type="button" class="menu_button" data-navigate="${back}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>上一步</span></button><div>${primary}</div></div>`;
}
function chatSummary(context, pill) {
    return `<div class="tr-summary-card"><div><span>角色</span><b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b></div><div><span>聊天檔</span><b data-field="chat-file">${escapeHtml(context.chatFileName ?? '未知')}</b></div><div><span>聊天 ID</span><b data-field="chat-id">${escapeHtml(context.chatId ?? '尚未同步')}</b></div><div><span>同步狀態</span><b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b></div></div>`;
}

;// ./src/ui/views/panel.ts







const TUTORIAL_SITE_URL = 'https://twinklestars1029.github.io/TavernRoamer-website/';
const GOOGLE_SETUP_GUIDE_URL = `${TUTORIAL_SITE_URL}setup/google-oauth/`;
const GOOGLE_SETUP_GITHUB_URL = 'https://github.com/TwinkleStars1029/TavernRoamer/blob/main/docs/gcp-setup.md';
function renderPanel(settings, context, driveState, floating = false, progressRunning = false, homeStatusInfo = { lastSyncedVersion: null, pendingUploads: 0 }) {
    const pill = statusPill(context.status);
    return `
    <div class="inline-drawer ${floating ? 'tr-modal' : ''}" ${floating ? 'role="dialog" aria-modal="true" aria-labelledby="tavern-roamer-dialog-title" tabindex="-1"' : ''}>
      <div class="inline-drawer-toggle inline-drawer-header ${floating ? 'tr-modal-header' : ''}">
        ${floating
        ? '<div><div class="tr-kicker">TavernRoamer</div><b class="tr-title" id="tavern-roamer-dialog-title">雲端漫遊</b></div>'
        : '<b>TavernRoamer</b>'}
        <div class="tr-header-actions">
          <button type="button" class="menu_button tr-icon-button" data-navigate="home" title="回到首頁" aria-label="首頁"><i class="fa-solid fa-house" aria-hidden="true"></i><span>首頁</span></button>
          <button type="button" class="menu_button tr-icon-button" data-navigate="appearance" title="外觀設定" aria-label="樣式"><i class="fa-solid fa-palette" aria-hidden="true"></i><span>樣式</span></button>
          <button type="button" class="menu_button tr-connection-button" data-navigate="settings" title="前往連線設定"><i class="tr-connection-dot ${driveState.connected ? 'is-connected' : ''}" data-field="drive-connection-dot" aria-hidden="true"></i><span data-field="drive-identity">${escapeHtml(driveState.connected ? driveState.email ?? '已連線' : '未連線')}</span></button>
          ${floating
        ? '<button type="button" class="menu_button tr-close" data-action="close-panel">關閉</button>'
        : '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'}
        </div>
      </div>
      <div class="inline-drawer-content ${floating ? 'tr-modal-content' : ''}">
        <div class="tr-body">

          <section class="tr-screen" data-screen="home" aria-labelledby="tr-screen-home-title">
            <h2 class="tr-visually-hidden" id="tr-screen-home-title" tabindex="-1">雲端漫遊首頁</h2>
            <div class="tr-current-card" data-field="home-current" ${driveState.connected ? '' : 'hidden'}>
              <div class="tr-operation-banner" data-field="progress-resume" hidden>
                <div class="tr-operation-summary"><i class="fa-solid fa-bars-progress" aria-hidden="true"></i><b data-field="progress-resume-label">操作進度</b></div>
                <div class="tr-progressbar tr-progress-resume-bar"><i data-field="progress-resume-bar"></i></div>
                <button type="button" class="menu_button" data-navigate="progress" data-field="progress-resume-action">查看進度</button>
              </div>
              <div data-field="home-current-content">
                ${renderHomeCurrentContent(settings, context, homeStatusInfo, driveState.connected, progressRunning)}
              </div>
            </div>
            <div class="tr-connect-guide" data-field="home-disconnected" ${driveState.connected ? 'hidden' : ''}>
              <div class="tr-connect-guide-head"><i class="fa-solid fa-cloud" aria-hidden="true"></i><div><h3>連線 Google Drive 後就能開始同步</h3><p>只需設定一次，之後每台裝置都連同一個 Drive。</p></div></div>
              <ol class="tr-connect-steps">
                <li><span>1</span><div><b>建立 Google Client ID</b><a class="tr-help-link" data-external-link href="${GOOGLE_SETUP_GITHUB_URL}" target="_blank" rel="noopener noreferrer">設定教學 <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="tr-visually-hidden">（新分頁）</span></a></div></li>
                <li><span>2</span><div><b>在設定頁填入並連線</b></div></li>
              </ol>
              <button type="button" class="menu_button ${driveState.connected ? '' : 'tr-primary'}" data-field="home-connect-primary" data-navigate="settings">前往連線</button>
            </div>
            <div class="tr-home-actions" data-field="home-actions" ${driveState.connected ? '' : 'hidden'}>
              <section class="tr-task-section" aria-labelledby="tr-chat-tasks-title">
                <div class="tr-task-section-head"><h3 id="tr-chat-tasks-title">聊天</h3></div>
                <div class="tr-task-grid tr-task-grid-chat">
                  ${taskButton('upload-confirm', 'fa-cloud-arrow-up', '上傳目前聊天', '存到雲端', false, progressRunning)}
                  ${taskButton('download-confirm', 'fa-rotate', '用雲端版更新', '先建立還原點', false, progressRunning)}
                  ${taskButton('browse-cloud', 'fa-cloud-arrow-down', '從雲端建立聊天', '帶回其他聊天', true, progressRunning)}
                </div>
              </section>
              <section class="tr-task-section" aria-labelledby="tr-environment-tasks-title">
                <div class="tr-task-section-head"><h3 id="tr-environment-tasks-title">酒館環境</h3></div>
                <div class="tr-environment-actions">
                  ${secondaryTaskButton('environment-backup', 'fa-box-archive', '備份環境', progressRunning)}
                  ${secondaryTaskButton('environment-restore', 'fa-box-open', '還原環境', progressRunning)}
                  ${secondaryTaskButton('restore-points', 'fa-clock-rotate-left', '管理還原點', progressRunning)}
                </div>
              </section>
              <p class="tr-home-progress-lock" data-field="home-progress-lock" role="status" ${progressRunning ? '' : 'hidden'}>目前操作完成後，才能開始新的操作。</p>
            </div>
          </section>

          <section class="tr-screen" data-screen="upload-confirm" aria-labelledby="tr-screen-upload-confirm-title" hidden>${stepHeading('upload-confirm', '確認', '確認上傳', '確認目前聊天、雲端版本與遠端使用所需環境。')}<div class="tr-upload-overview">${chatSummary(context, pill)}<div data-field="upload-preview"><div class="tr-callout">正在確認雲端聊天與環境備份…</div></div></div>${stepFooter('home', `${iconButton('upload-with-environment', 'fa-box-archive', '備份所選環境並上傳', true, true)}${iconButton('manual-upload', 'fa-upload', '確認上傳', true)}`)}</section>
          <section class="tr-screen" data-screen="download-confirm" aria-labelledby="tr-screen-download-confirm-title" hidden>${stepHeading('download-confirm', '確認', '確認更新目前聊天', '將使用雲端最新版更新目前聊天。')}${chatSummary(context, pill)}<div class="tr-callout tr-danger" data-field="download-conflict-warning" ${context.status === 'conflict' ? '' : 'hidden'}><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 本機有尚未上傳的變更，更新後只能從雲端還原點找回。</div><div class="tr-callout tr-danger"><b>更新方式：</b>系統會先將目前聊天保存成雲端還原點，再以雲端最新版取代目前內容。</div>${stepFooter('home', iconButton('download-latest', 'fa-rotate', '確認更新', true))}</section>
          <section class="tr-screen" data-screen="cloud" aria-labelledby="tr-screen-cloud-title" hidden>${stepHeading('cloud', '選擇', '選擇雲端聊天', '先選角色，再選擇要帶回本地的聊天。')}<div class="tr-cloud" data-field="cloud-list"><p class="tr-cloud-empty">載入中…</p></div>${stepFooter('home', '')}</section>
          <section class="tr-screen" data-screen="cloud-confirm" aria-labelledby="tr-screen-cloud-confirm-title" hidden>${stepHeading('cloud-confirm', '確認', '確認建立聊天', '將從雲端內容在本地建立一份新聊天。')}<div class="tr-summary-card"><div><span>角色</span><b data-field="pull-role">—</b></div><div><span>聊天 ID</span><b data-field="pull-chat">—</b></div></div><div class="tr-callout">若本地沒有這張角色卡，會先嘗試從雲端還原角色卡。</div>${stepFooter('cloud', iconButton('confirm-cloud-pull', 'fa-cloud-arrow-down', '建立本地聊天', true))}</section>
          <section class="tr-screen" data-screen="environment-backup" aria-labelledby="tr-screen-environment-backup-title" hidden>${stepHeading('environment-backup', '選擇', '選擇備份內容', '勾選要保存到雲端的酒館資料。')}${renderEnvironmentChoices('environment-backup', defaultEnvironmentChoices())}<div class="tr-callout">每個項目都會建立新版本，既有備份會保留。</div>${stepFooter('home', iconButton('backup-environment', 'fa-box-archive', '開始備份', true))}</section>
          <section class="tr-screen" data-screen="environment-restore" aria-labelledby="tr-screen-environment-restore-title" hidden>${stepHeading('environment-restore', '選擇', '選擇還原內容', '下一步會先檢查雲端備份，再讓你確認。')}${renderEnvironmentChoices('environment-restore', defaultEnvironmentChoices())}${stepFooter('home', iconButton('restore-environment', 'fa-arrow-right', '預覽還原內容', true))}</section>
          <section class="tr-screen" data-screen="restore-confirm" aria-labelledby="tr-screen-restore-confirm-title" hidden>${stepHeading('restore-confirm', '確認', '確認還原內容', '套用前會先備份本機現況。')}<div class="tr-restore-preview" data-field="restore-preview" role="status" aria-live="polite" aria-busy="false"></div><button type="button" class="menu_button tr-preview-retry" data-action="retry-restore-preview" data-drive-required hidden><i class="fa-solid fa-rotate-right"></i><span>重新檢查</span></button><div class="tr-callout tr-danger">只有成功確認到雲端備份的項目才會開放還原。</div>${stepFooter('environment-restore', iconButton('confirm-restore', 'fa-box-open', '確認還原', true))}</section>
          <section class="tr-screen" data-screen="restore-points" aria-labelledby="tr-screen-restore-points-title" hidden>
            ${stepHeading('restore-points', '管理', '雲端還原點', '先選角色與對話，再查看該對話完整的 _pre_restore 內容。')}
            <div class="tr-restore-toolbar">
              <label class="tr-field"><span>搜尋角色或對話</span><input type="search" class="text_pole" data-field="restore-search" placeholder="輸入名稱" /></label>
              <label class="tr-field"><span>排序</span><select class="text_pole" data-field="restore-sort"><option value="latest">最新還原點</option><option value="oldest">最舊還原點</option><option value="count">批次數量</option><option value="name">角色 / 對話名稱</option></select></label>
              <button type="button" class="menu_button" data-action="refresh-restore-points" data-drive-required><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>重新整理</span></button>
            </div>
            <div class="tr-restore-selection" data-field="restore-selection" hidden>
              <span data-field="restore-selection-count" aria-live="polite">已選 0 個檔案</span>
              <button type="button" class="menu_button" data-action="trash-selected-restore-points" data-drive-required disabled><i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>移到 Drive 垃圾桶</span></button>
              <details class="tr-restore-advanced"><summary>進階操作</summary><button type="button" class="menu_button tr-danger-button" data-action="delete-selected-restore-points-permanently" data-drive-required disabled><i class="fa-solid fa-trash" aria-hidden="true"></i><span>永久刪除已選</span></button></details>
            </div>
            <p class="tr-restore-point-feedback" data-field="restore-point-feedback" role="status" aria-live="polite"></p>
            <div data-field="restore-overview">
              <div class="tr-restore-cleanup-card">
                <div><b>全部對話清理</b><small>會先掃描全部 _pre_restore 並顯示影響範圍，確認後才移到垃圾桶。</small></div>
                <div class="tr-restore-point-actions"><button type="button" class="menu_button" data-restore-age="15" data-restore-scope="all" data-drive-required><i class="fa-solid fa-calendar-xmark" aria-hidden="true"></i><span>清理超過 15 天</span></button><button type="button" class="menu_button" data-restore-age="30" data-restore-scope="all" data-drive-required><i class="fa-solid fa-calendar-xmark" aria-hidden="true"></i><span>清理超過 30 天</span></button></div>
              </div>
              <div class="tr-restore-chat-list" data-field="restore-chat-list" aria-busy="false"><p class="tr-cloud-empty">尚未載入。</p></div>
            </div>
            <div data-field="restore-detail" hidden>
              <button type="button" class="menu_button tr-back-inline" data-action="back-to-restore-chats"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>回到對話清單</span></button>
              <div class="tr-restore-detail-head"><div><small data-field="restore-detail-role">角色</small><h3 data-field="restore-detail-chat" tabindex="-1">對話</h3></div><div class="tr-restore-point-actions"><button type="button" class="menu_button" data-restore-age="15" data-restore-scope="chat" data-drive-required><span>清理超過 15 天</span></button><button type="button" class="menu_button" data-restore-age="30" data-restore-scope="chat" data-drive-required><span>清理超過 30 天</span></button></div></div>
              <div class="tr-restore-detail-select"><label><input type="checkbox" data-action="select-all-restore-points" /><span>全選這個對話的檔案</span></label></div>
              <div class="tr-restore-point-list" data-field="restore-point-list" aria-busy="false"><p class="tr-cloud-empty">請選擇對話。</p></div>
            </div>
            ${stepFooter('home', '')}
          </section>
          <section class="tr-screen" data-screen="progress" aria-labelledby="tr-screen-progress-title" hidden>${stepHeading('progress', '執行', '執行進度', '你可以回到首頁，稍後再開啟此頁查看狀態。')}<div class="tr-progress-state tr-state-running" data-field="progress-state-wrap" role="status" aria-live="polite"><i class="fa-solid fa-spinner fa-spin"></i><b data-field="progress-state">正在處理</b></div><div class="tr-progress" data-field="progress" aria-live="polite" hidden></div><div class="tr-step-footer"><button type="button" class="menu_button" data-navigate="home">回到首頁</button></div></section>
          <section class="tr-screen" data-screen="settings" aria-labelledby="tr-screen-settings-title" hidden>${stepHeading('settings', '設定', '連線與同步設定', '設定 Google Drive 與這台裝置的同步方式。')}<div class="tr-settings-content">
            <p class="tr-guidance" data-field="guidance" ${settings.googleClientId.trim() ? 'hidden' : ''}>第一次使用請填入 Google Client ID，再按「連線 Google Drive」。</p>
            <label class="tr-field"><span>Google Client ID</span><input class="text_pole" data-input="googleClientId" value="${escapeAttribute(settings.googleClientId)}" autocomplete="off" /></label>
            <a class="tr-help-link" data-external-link href="${GOOGLE_SETUP_GUIDE_URL}" target="_blank" rel="noopener noreferrer">如何取得 Google Client ID？ <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="tr-visually-hidden">（新分頁）</span></a>
            <label class="tr-field"><span>裝置名稱</span><input class="text_pole" data-input="deviceName" value="${escapeAttribute(settings.deviceName)}" autocomplete="off" /></label>
            <label class="tr-field tr-inline"><span>自動同步每 N 則</span><input class="text_pole" data-input="autoSyncEveryN" type="number" min="1" step="1" value="${settings.autoSyncEveryN}" /></label>
            <label class="checkbox_label"><input data-input="autoSyncEnabled" type="checkbox" ${settings.autoSyncEnabled ? 'checked' : ''} /><span>啟用自動同步</span></label>
            <div class="tr-actions">${iconButton('connect-drive', 'fa-plug', '連線 Google Drive')} ${iconButton('save', 'fa-save', '儲存設定')}</div>
            <div class="tr-self-check-panel">
              <div class="tr-self-check-head"><div><b>系統檢查</b><small>快速檢查不會改動聊天、角色卡或環境資料；Drive 測試只建立並清理暫存檔。</small></div><div class="tr-actions"><button type="button" class="menu_button" data-self-check-mode="quick"><i class="fa-solid fa-stethoscope"></i><span>快速檢查</span></button><button type="button" class="menu_button" data-self-check-mode="advanced"><i class="fa-solid fa-flask"></i><span>進階診斷</span></button></div></div>
              <div class="tr-self-check-results" data-field="self-check-results" aria-live="polite"></div>
            </div>
          </div>${stepFooter('home', '')}</section>
          <section class="tr-screen" data-screen="appearance" aria-labelledby="tr-screen-appearance-title" hidden>${stepHeading('appearance', '設定', '外觀設定', '調整雲端漫遊所有頁面的配色；下方變更會即時預覽，儲存後保留。')}${appearanceControls(settings)}${stepFooter('home', iconButton('save-appearance', 'fa-save', '儲存外觀'))}</section>

          <pre data-field="report" class="tr-report" aria-live="polite"></pre>
        </div>
      </div>
    </div>
  `;
}
function appearanceControls(settings) {
    const appearance = normalizeAppearance(settings.appearance);
    const choices = (values, selected) => values
        .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
    return `<div class="tr-appearance-controls">
    <label class="tr-field"><span>主題模式</span><select class="text_pole" data-appearance="mode">${choices([['tavern', '跟隨酒館'], ['light', '淺色'], ['dark', '深色']], appearance.mode)}</select></label>
    <fieldset class="tr-fieldset"><legend>強調色</legend><div class="tr-accent-presets">
      <button type="button" class="menu_button" data-accent="default" aria-pressed="${appearance.accentColor === null}">主題預設</button>
      ${accentPresets.map(preset => `<button type="button" class="menu_button tr-swatch" data-accent="${preset.color}" style="--tr-swatch: ${preset.color}" aria-pressed="${appearance.accentColor === preset.color}"><i aria-hidden="true"></i><span>${preset.name}</span></button>`).join('')}
    </div><label class="tr-color-field"><span>自訂顏色</span><input type="color" data-appearance="accentColor" value="${appearance.accentColor ?? '#8aa8ff'}" /><span data-field="appearance-color">${appearance.accentColor ?? '主題預設'}</span></label></fieldset>
    <label class="tr-field"><span>色調</span><select class="text_pole" data-appearance="tone">${choices([['soft', '柔和'], ['standard', '標準'], ['vivid', '鮮明']], appearance.tone)}</select><small class="tr-muted">調整卡片背景與邊框的強度。</small></label>
    <div class="tr-appearance-preview tr-summary-card"><div><span>配色預覽</span><b>標題與內文</b><small class="tr-muted">次要說明文字</small></div><div><span>操作與狀態</span><button type="button" class="menu_button tr-primary" disabled>主要按鈕</button><div class="tr-preview-statuses"><span class="tr-state-success">成功</span><span class="tr-state-warning">警告</span><span class="tr-state-error">錯誤</span></div></div></div>
    <p class="tr-muted">成功、警告與錯誤保留辨識色。返回上一頁會取消尚未儲存的變更。</p>
    <div class="tr-actions">${iconButton('reset-appearance', 'fa-rotate-left', '重設為跟隨酒館')}</div>
    <p data-field="appearance-feedback" role="status" aria-live="polite"></p>
  </div>`;
}
function renderHomeCurrentContent(settings, context, info, driveConnected, progressRunning) {
    const pill = statusPill(context.status);
    return `
    <div class="tr-current-main">
      <div class="tr-current-avatar" data-field="home-current-avatar" aria-hidden="true">${renderHomeCurrentAvatar(context)}</div>
      <div class="tr-current-details">
        <b data-field="character">${escapeHtml(context.characterName ?? '未選取')}</b>
        <span class="tr-current-filename" data-field="chat-file" title="${escapeAttribute(context.chatFileName ?? '未開啟聊天')}">${escapeHtml(context.chatFileName ?? '未開啟聊天')}</span>
        <div class="tr-current-status" role="status" aria-live="polite">
          <b class="tr-pill tr-tone-${pill.tone}" data-field="status">${pill.label}</b>
          <p class="tr-current-meta" data-field="home-current-meta">${renderHomeCurrentMeta(settings, info)}</p>
          <p class="tr-current-feedback" data-field="home-current-feedback"></p>
        </div>
      </div>
      <div class="tr-current-cta" data-field="home-current-cta">${renderHomeCurrentAction(context, driveConnected, progressRunning)}</div>
    </div>
  `;
}
function renderHomeCurrentAvatar(context) {
    const initial = Array.from(context.characterName?.trim() ?? '')[0];
    return initial ? escapeHtml(initial) : '<i class="fa-solid fa-user" aria-hidden="true"></i>';
}
function renderHomeCurrentMeta(settings, info, flushing = false) {
    const pending = formatPendingLabel(info.pendingUploads);
    const flushButton = `<button type="button" class="menu_button tr-queue-flush${flushing ? ' tr-disabled' : ''}" data-field="home-flush-queue" data-action="flush-queue" data-drive-required data-home-task${flushing ? ' aria-busy="true" disabled' : ''}><i class="fa-solid ${flushing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'}" aria-hidden="true"></i><span>${flushing ? '補傳中…' : '立即補傳'}</span></button>`;
    return `<span>最後同步 <b data-field="last-synced">${escapeHtml(formatLastSyncedLabel(info.lastSyncedVersion))}</b></span><span>自動同步 <b data-field="auto-sync">${escapeHtml(formatAutoSyncLabel(settings))}</b></span>${pending.visible ? `<span data-field="queue-segment"><b data-field="queue">${escapeHtml(pending.text)}</b>${flushButton}</span>` : ''}`;
}
const UPLOAD_ACTION = { target: 'upload-confirm', icon: 'fa-cloud-arrow-up', label: '上傳目前聊天' };
const REUPLOAD_ACTION = { target: 'upload-confirm', icon: 'fa-cloud-arrow-up', label: '重新上傳' };
const REFRESH_ACTION = { target: 'action:refresh-status', icon: 'fa-rotate-right', label: '重新檢查' };
/** 每個同步狀態對應的唯一主要下一步；null 表示不需要動作（conflict 另外處理）。 */
const HOME_CURRENT_ACTIONS = {
    local_dirty: { ...UPLOAD_ACTION, note: null },
    newer_remote: { target: 'download-confirm', icon: 'fa-rotate', label: '用雲端版更新', note: '更新前會先建立還原點' },
    untracked: { ...UPLOAD_ACTION, note: '第一次上傳會建立雲端版本' },
    remote_available: { ...UPLOAD_ACTION, note: '雲端已有這段聊天的版本，上傳會新增一份；要改用雲端內容請用下方「用雲端版更新」' },
    remote_missing: { ...REUPLOAD_ACTION, note: '雲端找不到上次同步的版本' },
    remote_mismatch: { ...REUPLOAD_ACTION, note: '雲端最新版比上次同步的還舊，可能被清理過' },
    check_failed: { ...REFRESH_ACTION, note: '無法連到雲端核對' },
    unknown: { ...REFRESH_ACTION, note: '尚未核對雲端版本' },
    synced: null,
    not_connected: null
};
/** 首頁狀態卡的唯一主要下一步；狀態改變時只重繪這一塊，live region 本身保持不變。 */
function renderHomeCurrentAction(context, driveConnected, progressRunning, refreshing = false) {
    const hasChat = Boolean(context.characterName?.trim() && context.chatFileName?.trim());
    const disabled = progressRunning || !driveConnected;
    if (!hasChat) {
        return '<p class="tr-current-empty"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>請先在酒館開啟一段聊天</span></p>';
    }
    if (context.status === 'conflict') {
        return `<div class="tr-current-action tr-current-conflict"><p class="tr-current-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>兩台裝置都改過這段聊天，請選擇要保留哪一邊。</span></p>${homeCurrentButton('home-current-conflict-upload', 'data-navigate="upload-confirm"', 'fa-cloud-arrow-up', '上傳本機版本', false, disabled)}${homeCurrentButton('home-current-conflict-download', 'data-navigate="download-confirm"', 'fa-rotate', '改用雲端版', false, disabled)}</div>`;
    }
    const action = HOME_CURRENT_ACTIONS[context.status];
    if (!action)
        return '';
    const isRefresh = action.target === 'action:refresh-status';
    const destination = isRefresh ? 'data-action="refresh-status"' : `data-navigate="${action.target}"`;
    const busy = isRefresh && refreshing;
    const button = homeCurrentButton('home-current-primary', destination, action.icon, busy ? '檢查中…' : action.label, driveConnected, disabled || busy, busy);
    return action.note
        ? `<div class="tr-current-action">${button}<small>${escapeHtml(action.note)}</small></div>`
        : button;
}
function homeCurrentButton(field, destination, icon, label, primary, disabled, busy = false) {
    const buttonClass = `${primary ? ' tr-primary' : ''}${disabled ? ' tr-disabled' : ''}`;
    return `<button type="button" class="menu_button${buttonClass}" data-field="${field}" ${destination} data-drive-required data-home-task${busy ? ' aria-busy="true"' : ''}${disabled ? ' disabled' : ''}><i class="fa-solid ${busy ? 'fa-spinner fa-spin' : icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
}
function taskButton(target, icon, title, description, action = false, disabled = false) {
    const destination = action ? `data-action="${target}"` : `data-navigate="${target}"`;
    return `<button type="button" class="tr-task-card${disabled ? ' tr-disabled' : ''}" ${destination} data-drive-required data-home-task${disabled ? ' disabled' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span><b>${title}</b><small>${description}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
}
function secondaryTaskButton(target, icon, title, disabled = false) {
    return `<button type="button" class="menu_button tr-secondary-task${disabled ? ' tr-disabled' : ''}" data-navigate="${target}" data-drive-required data-home-task${disabled ? ' disabled' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${title}</span></button>`;
}
function renderRestorePreviewHtml(cloudFiles, selectedItems = ENVIRONMENT_ITEM_ORDER) {
    const overwrite = selectedItems.filter(kind => Boolean(cloudFiles[kind]));
    const skipped = selectedItems.filter(kind => !cloudFiles[kind]);
    const ready = overwrite.length > 0
        ? overwrite
            .map(kind => `<div class="tr-preview-row"><i class="fa-solid fa-cloud-arrow-down"></i><span><b>${environmentPresentation_environmentLabel(kind)}</b><small class="tr-preview-filename">${escapeHtml(cloudFiles[kind] ?? '')}</small></span><small>備份本機後覆蓋</small></div>`)
            .join('')
        : '<p class="tr-muted">沒有找到可還原的項目</p>';
    const missing = skipped.length > 0
        ? `<div class="tr-preview-group"><b>將略過</b>${skipped.map(kind => `<div class="tr-preview-row is-skipped"><i class="fa-solid fa-minus"></i><span>${environmentPresentation_environmentLabel(kind)}</span><small>雲端沒有備份</small></div>`).join('')}</div>`
        : '';
    return `<div class="tr-preview-group"><b>將從雲端還原</b>${ready}</div>${missing}`;
}
function renderRestorePreviewErrorHtml(message) {
    return `<div class="tr-callout tr-danger"><b>無法確認雲端備份</b><br />${escapeHtml(message)}<br /><small>為避免在資訊不完整時覆蓋本機內容，目前不會開放還原。</small></div>`;
}
function renderRestorePointChatListHtml(chats) {
    if (chats.length === 0) {
        return '<div class="tr-callout"><b>沒有找到雲端還原點</b><br /><small>SillyTavernSync 中目前沒有任何對話的 _pre_restore 資料夾。</small></div>';
    }
    return chats.map(chat => `
    <button type="button" class="tr-restore-chat-card" data-restore-chat data-role-key="${escapeAttribute(chat.roleKey)}" data-chat-id="${escapeAttribute(chat.chatId)}">
      <span class="tr-restore-chat-main"><small>${escapeHtml(chat.roleKey)}</small><b>${escapeHtml(chat.chatId)}</b>${chat.duplicatePath ? '<em><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 偵測到同名資料夾，已合併顯示</em>' : ''}</span>
      <span class="tr-restore-chat-meta"><b>${chat.batchCount} 個批次</b><small>${chat.latestCreatedAt ? `最新 ${escapeHtml(formatDateTime(chat.latestCreatedAt))}` : '存在空的 _pre_restore'}</small></span>
      <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
    </button>`).join('');
}
function renderRestorePointListHtml(batches, selectedFileIds = new Set()) {
    if (batches.length === 0) {
        return '<div class="tr-callout"><b>_pre_restore 是空的</b><br /><small>這個對話已有 _pre_restore 資料夾，但目前沒有批次。</small></div>';
    }
    return batches.map(batch => `
    <section class="tr-restore-batch" aria-labelledby="tr-restore-batch-${escapeAttribute(batch.folderId)}">
      <div class="tr-restore-batch-head">
        <div><b id="tr-restore-batch-${escapeAttribute(batch.folderId)}"><time datetime="${escapeAttribute(batch.createdAt)}">${escapeHtml(formatDateMinute(batch.createdAt))}</time></b><small>${batch.files.length} 個檔案${batch.emptyFolders.length ? ` · ${batch.emptyFolders.length} 個空資料夾` : ''}</small></div>
        ${renderRestorePointTechnicalDetails(batch)}
      </div>
      ${renderRestorePointIssues(batch)}
      <div class="tr-restore-files">
        ${batch.files.map(file => `
          <label class="tr-restore-file">
            <input type="checkbox" data-restore-file="${escapeAttribute(file.fileId)}" ${selectedFileIds.has(file.fileId) ? 'checked' : ''} aria-label="選取 ${escapeAttribute(file.relativePath)}" />
            <span class="tr-restore-file-main"><b>${escapeHtml(restorePointKindLabel(file.kind))}</b><span>${escapeHtml(restorePointFileSummary(file))}</span></span>
          </label>`).join('')}
        ${batch.emptyFolders.map(folder => `<div class="tr-restore-file is-empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><span class="tr-restore-file-main"><b>空資料夾</b><span>${escapeHtml(folder.relativePath)}</span></span></div>`).join('')}
      </div>
    </section>`).join('');
}
function renderRestorePointTechnicalDetails(batch) {
    const fileDetails = batch.files.map(file => `
    <div class="tr-restore-technical-group">
      <b>${escapeHtml(restorePointKindLabel(file.kind))} · ${escapeHtml(restorePointFileSummary(file))}</b>
      <div class="tr-restore-technical-row"><small>完整檔名</small><code>${escapeHtml(file.filename)}</code></div>
      <div class="tr-restore-technical-row"><small>Drive 建立時間</small><time datetime="${escapeAttribute(file.uploadedAt)}">${escapeHtml(formatDateTime(file.uploadedAt))}</time></div>
    </div>`).join('');
    const folderDetails = batch.emptyFolders.map(folder => `
    <div class="tr-restore-technical-group">
      <b>空資料夾 · ${escapeHtml(folder.relativePath)}</b>
      <div class="tr-restore-technical-row"><small>Drive 建立時間</small><time datetime="${escapeAttribute(folder.createdAt)}">${escapeHtml(formatDateTime(folder.createdAt))}</time></div>
    </div>`).join('');
    return `
    <details class="tr-restore-technical">
      <summary><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>技術資訊</span></summary>
      <div class="tr-restore-technical-content">
        <div class="tr-restore-technical-row"><small>批次 ID</small><code>${escapeHtml(batch.name)}</code></div>
        <div class="tr-restore-technical-row"><small>精確建立時間</small><time datetime="${escapeAttribute(batch.createdAt)}">${escapeHtml(formatDateTime(batch.createdAt))}</time></div>
        ${fileDetails}${folderDetails}
      </div>
    </details>`;
}
function renderRestorePointIssues(batch) {
    const labels = batch.issues.map(issue => ({
        empty: '這個批次沒有檔案',
        unknown_items: '包含未識別的檔案或資料夾',
        invalid_timestamp: '批次名稱不含有效時間，改用 Drive 建立時間'
    })[issue]);
    return labels.length ? `<div class="tr-restore-issues">${labels.map(label => `<span><i class="fa-solid fa-circle-info" aria-hidden="true"></i>${label}</span>`).join('')}</div>` : '';
}
function restorePointKindLabel(kind) {
    return ({
        chat: '聊天', character: '角色卡', world: '世界書', persona: 'Persona', preset: 'Preset', regex: 'Regex', other: '其他'
    })[kind];
}
function restorePointFileSummary(file) {
    const parsed = parseVersionFilename(file.filename);
    if (!parsed)
        return file.relativePath;
    const extension = /\.([^.]+)$/.exec(file.filename)?.[1]?.toUpperCase();
    return [parsed.device, extension].filter((part) => Boolean(part)).join(' · ');
}
function formatDateMinute(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '時間不明' : formatLocalMinute(date);
}
function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '時間不明' : formatLocalTime(date);
}
function renderUploadPreviewHtml(filename) {
    if (!filename) {
        return '<div class="tr-upload-cloud-summary"><span>目前雲端檔案</span><b>尚無檔案</b></div><div class="tr-inline-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>雲端尚無此聊天，這次上傳會建立第一份聊天版本。</span></div>';
    }
    return `<div class="tr-upload-cloud-summary"><span>雲端最新版本</span><b class="tr-cloud-filename">${escapeHtml(filename)}</b></div><div class="tr-inline-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>這次會新增一份聊天版本；超過保留數量時才會清理最舊版本。</span></div>`;
}
function renderChatUploadPreparationHtml(preparation) {
    const chat = renderUploadPreviewHtml(preparation.latestChatFilename);
    if (preparation.recoveryStatus === 'ready')
        return chat;
    const choices = uploadEnvironmentChoices(preparation);
    const callout = preparation.isFirstUpload
        ? '<div class="tr-callout"><b>這是此聊天第一次上傳。</b><br />若要在其他裝置直接建立聊天，建議一起備份角色卡與相關環境。</div>'
        : '<div class="tr-callout tr-danger"><b>雲端缺少角色卡。</b><br />聊天仍可建立新版本，但其他裝置目前無法從雲端還原這張角色並建立聊天。</div>';
    return `${chat}${callout}${renderEnvironmentChoices('chat-upload', choices)}<div class="tr-callout"><small>Persona 可能包含個人資料，預設不勾選；你可以依需要加入。</small></div>`;
}
function uploadEnvironmentChoices(preparation) {
    const availability = new Map(preparation.environment.map(item => [item.kind, item]));
    return ENVIRONMENT_ITEM_ORDER.map(kind => {
        const item = availability.get(kind);
        const isMissing = !item?.available;
        const badge = kind === 'character'
            ? (isMissing ? '必要' : '已有備份')
            : kind === 'world'
                ? (isMissing ? '建議' : '已有備份')
                : (item?.available ? '已有備份' : '選填');
        return {
            kind,
            selected: isMissing && (kind === 'character' || kind === 'world'),
            badge,
            latestFilename: item?.latestFilename ?? null
        };
    });
}
function renderCloudRoleListHtml(roles) {
    if (roles.length === 0) {
        return '<p class="tr-cloud-empty">雲端沒有任何備份資料夾</p>';
    }
    const items = roles
        .map(role => `
        <li>
          <button type="button" class="menu_button tr-cloud-role" data-cloud-role="${escapeAttribute(role.roleKey)}">
            <i class="fa-solid fa-user" aria-hidden="true"></i><span>${escapeHtml(role.roleKey)}</span><i class="fa-solid fa-chevron-right tr-cloud-role-chevron" aria-hidden="true"></i>
          </button>
        </li>`)
        .join('');
    return `<div class="tr-cloud-head"><b>選擇角色</b></div><ul class="tr-cloud-list">${items}</ul>`;
}
function renderCloudChatListHtml(roleKey, entries) {
    const rows = entries
        .map(entry => {
        const latestLabel = entry.latest ? formatLastSyncedLabel(entry.latest.filename) : '—';
        const device = entry.latest?.device ?? '—';
        return `
        <li class="tr-cloud-chat-row">
          <span class="tr-cloud-chat-id">${escapeHtml(entry.chatId)}</span>
          <span class="tr-cloud-chat-info">${escapeHtml(latestLabel)}｜${escapeHtml(device)}｜${entry.versionCount} 版</span>
          <button type="button" class="menu_button tr-cloud-pull"
            data-cloud-pull-role="${escapeAttribute(roleKey)}"
            data-cloud-pull-chat="${escapeAttribute(entry.chatId)}"
            ${entry.versionCount === 0 ? 'disabled' : ''}>建立</button>
        </li>`;
    })
        .join('');
    return `
    <div class="tr-cloud-head">
      <button type="button" class="menu_button tr-cloud-back" data-cloud-back="1">
        <i class="fa-solid fa-arrow-left"></i><span>返回角色</span>
      </button>
      <b>${escapeHtml(roleKey)}</b>
    </div>
    <ul class="tr-cloud-list">${rows.length > 0 ? rows : '<li class="tr-cloud-empty">這個角色底下沒有聊天</li>'}</ul>
  `;
}

;// ./src/ui/progressModel.ts
function isSettledProgressState(state) {
    return state === 'done' || state === 'queued' || state === 'warning' || state === 'error' || state === 'aborted' || state === 'skipped';
}

;// ./src/ui/views/progress.ts

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
function progressIcon(state) {
    switch (state) {
        case 'active':
            return '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
        case 'done':
            return '<span class="tr-ok" aria-label="完成">✓</span>';
        case 'queued':
            return '<i class="fa-solid fa-clock tr-queued" aria-label="等待補傳"></i>';
        case 'warning':
            return '<i class="fa-solid fa-triangle-exclamation tr-abort" aria-label="部分完成"></i>';
        case 'error':
            return '<span class="tr-err" aria-label="失敗">✗</span>';
        case 'aborted':
            return '<span class="tr-abort" aria-label="已中止">⚠</span>';
        case 'skipped':
        case 'pending':
        default:
            return '<span class="tr-dot" aria-hidden="true">·</span>';
    }
}

;// ./src/ui/panelController.ts











const DRIVE_GUARD_TITLE = '請先連線 Google Drive';
const PROGRESS_LOCK_TITLE = '目前操作完成後，才能開始新的操作';
/** 會開始新進度操作的按鈕；進度執行中一律停用。 */
const PROGRESS_START_ACTIONS = new Set([
    'backup-environment',
    'confirm-restore',
    'download-latest',
    'confirm-cloud-pull',
    'manual-upload',
    'upload-with-environment'
]);
const RESTORE_POINT_SELECTION_ACTIONS = new Set([
    'trash-selected-restore-points',
    'delete-selected-restore-points-permanently'
]);





function createPanel(options) {
    let root = null;
    let removeViewportListener = null;
    let removeKeyboardListener = null;
    let restoreFocusTo = null;
    let context = options.getContext();
    let driveState = options.getDriveState();
    let appearanceDraft = normalizeAppearance(options.getSettings().appearance);
    let currentScreen = 'home';
    let progressOp = null;
    let progressTitle = '';
    let progressRows = [];
    let progressRunning = false;
    let activeProgressTasks = 0;
    let homeStatusInfo = { lastSyncedVersion: null, pendingUploads: 0 };
    const progressRetryHandlers = new Map();
    let lastPullTarget = null;
    let pendingRestoreItems = [];
    let restorePreviewReady = false;
    let restorePreviewLoading = false;
    let restorePointChats = [];
    let restorePointBatches = [];
    let restorePointTarget = null;
    const selectedRestorePointFiles = new Map();
    let restorePointLoadRevision = 0;
    let activeRestorePointLoads = 0;
    let restorePointDestructiveOperationRunning = false;
    let selfCheckRunning = false;
    let selfCheckMode = 'quick';
    let selfCheckProgress = null;
    let selfCheckResults = [];
    let pendingUploadPreparation = null;
    let uploadPreviewRevision = 0;
    let statusRefreshRunning = false;
    let queueFlushRunning = false;
    function mount({ floating = false } = {}) {
        if (root) {
            return;
        }
        const hostDocument = getHostDocument();
        const activeElement = hostDocument.activeElement;
        restoreFocusTo = floating && isHtmlElement(activeElement, hostDocument) ? activeElement : null;
        root = hostDocument.createElement('section');
        root.id = 'tavern-roamer-panel';
        currentScreen = 'home';
        appearanceDraft = normalizeAppearance(options.getSettings().appearance);
        applyAppearance(root, appearanceDraft);
        root.innerHTML = renderPanel(options.getSettings(), context, driveState, floating, progressRunning, homeStatusInfo);
        const mountPoint = floating ? hostDocument.body : findMountPoint(hostDocument);
        if (floating || mountPoint === hostDocument.body) {
            root.classList.add('tr-floating');
            prepareFloatingHost(root, hostDocument.defaultView ?? window);
        }
        injectStyle(hostDocument);
        mountPoint.append(root);
        if (floating) {
            const targetWindow = hostDocument.defaultView ?? window;
            const syncViewportSize = () => {
                if (root) {
                    prepareFloatingHost(root, targetWindow);
                }
            };
            targetWindow.addEventListener('resize', syncViewportSize);
            targetWindow.visualViewport?.addEventListener('resize', syncViewportSize);
            removeViewportListener = () => {
                targetWindow.removeEventListener('resize', syncViewportSize);
                targetWindow.visualViewport?.removeEventListener('resize', syncViewportSize);
            };
        }
        bindEvents();
        applyConnectionGuards();
        if (progressRows.length > 0) {
            renderProgress();
        }
        renderSelfCheckArea();
        if (floating) {
            bindDialogKeyboard(hostDocument);
            focusScreenHeading('home');
        }
    }
    function unmount() {
        removeViewportListener?.();
        removeViewportListener = null;
        removeKeyboardListener?.();
        removeKeyboardListener = null;
        root?.remove();
        root = null;
        if (restoreFocusTo?.isConnected) {
            restoreFocusTo.focus({ preventScroll: true });
        }
        restoreFocusTo = null;
    }
    function updateContext(nextContext, info) {
        context = nextContext;
        if (info) {
            homeStatusInfo = info;
        }
        if (!root) {
            return;
        }
        // 只更新狀態卡內容；帶 role="status" 的 .tr-current-status 節點保持不變，讀屏器才會播報變更。
        const avatar = root.querySelector('[data-field="home-current-avatar"]');
        if (avatar)
            avatar.innerHTML = renderHomeCurrentAvatar(context);
        renderHomeMeta();
        renderHomeCta();
        const conflictWarning = root.querySelector('[data-field="download-conflict-warning"]');
        if (conflictWarning)
            conflictWarning.hidden = context.status !== 'conflict';
        setText('character', context.characterName ?? '未選取');
        setText('chat-id', context.chatId ?? '尚未同步');
        setText('chat-file', context.chatFileName ?? '未開啟聊天');
        root.querySelector('.tr-current-filename')?.setAttribute('title', context.chatFileName ?? '未開啟聊天');
        const pill = statusPill(context.status);
        for (const statusEl of root.querySelectorAll('[data-field="status"]')) {
            statusEl.className = `tr-pill tr-tone-${pill.tone}`;
            statusEl.textContent = pill.label;
        }
        applyConnectionGuards();
    }
    function renderHomeMeta() {
        const meta = root?.querySelector('[data-field="home-current-meta"]');
        if (meta)
            meta.innerHTML = renderHomeCurrentMeta(options.getSettings(), homeStatusInfo, queueFlushRunning);
    }
    function renderHomeCta() {
        const cta = root?.querySelector('[data-field="home-current-cta"]');
        if (cta)
            cta.innerHTML = renderHomeCurrentAction(context, driveState.connected, progressRunning, statusRefreshRunning);
    }
    function setHomeFeedback(message, error = false) {
        const feedback = root?.querySelector('[data-field="home-current-feedback"]');
        if (!feedback)
            return;
        feedback.textContent = message;
        feedback.classList.toggle('tr-state-error', error);
    }
    async function refreshStatus() {
        if (statusRefreshRunning)
            return;
        statusRefreshRunning = true;
        setHomeFeedback('');
        renderHomeCta();
        applyConnectionGuards();
        try {
            await options.onRefreshStatus();
        }
        catch (error) {
            setHomeFeedback(`重新檢查失敗：${panelController_errorMessage(error)}`, true);
        }
        finally {
            statusRefreshRunning = false;
            renderHomeCta();
            applyConnectionGuards();
        }
    }
    async function flushQueue() {
        if (queueFlushRunning)
            return;
        queueFlushRunning = true;
        setHomeFeedback('');
        renderHomeMeta();
        applyConnectionGuards();
        try {
            const result = await options.onFlushQueue();
            setHomeFeedback(result.remaining > 0
                ? `已補傳 ${result.uploaded} 筆，還有 ${result.remaining} 筆未完成`
                : `已補傳 ${result.uploaded} 筆`);
        }
        catch (error) {
            setHomeFeedback(`補傳失敗：${panelController_errorMessage(error)}`, true);
        }
        finally {
            queueFlushRunning = false;
            renderHomeMeta();
            applyConnectionGuards();
        }
    }
    function updateDriveStatus(nextState) {
        driveState = nextState;
        if (!root) {
            return;
        }
        setText('drive-identity', driveState.connected ? driveState.email ?? '已連線' : '未連線');
        root.querySelector('[data-field="drive-connection-dot"]')?.classList.toggle('is-connected', driveState.connected);
        const disconnected = root.querySelector('[data-field="home-disconnected"]');
        const homeActions = root.querySelector('[data-field="home-actions"]');
        const currentSummary = root.querySelector('[data-field="home-current"]');
        if (disconnected)
            disconnected.hidden = driveState.connected;
        if (homeActions)
            homeActions.hidden = !driveState.connected;
        if (currentSummary)
            currentSummary.hidden = !driveState.connected;
        root.querySelector('[data-field="home-connect-primary"]')
            ?.classList.toggle('tr-primary', !driveState.connected);
        root.querySelector('[data-field="home-current-primary"]')
            ?.classList.toggle('tr-primary', driveState.connected);
        applyConnectionGuards();
    }
    function invalidateUploadPreparation() {
        pendingUploadPreparation = null;
        uploadPreviewRevision += 1;
        if (!root || currentScreen !== 'upload-confirm')
            return;
        const preview = root.querySelector('[data-field="upload-preview"]');
        if (preview) {
            preview.innerHTML = '<div class="tr-callout tr-danger"><b>目前聊天已變更。</b><br />請回到首頁後重新進入上傳確認。</div>';
            preview.setAttribute('aria-busy', 'false');
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
        const resume = root?.querySelector('[data-field="progress-resume"]');
        const lock = root?.querySelector('[data-field="home-progress-lock"]');
        if (lock)
            lock.hidden = !progressRunning;
        if (progressRows.length === 0) {
            el.innerHTML = '';
            el.hidden = true;
            if (resume)
                resume.hidden = true;
            applyConnectionGuards();
            return;
        }
        el.hidden = false;
        const settled = progressRows.filter(row => isSettledProgressState(row.state)).length;
        const total = progressRows.length;
        const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
        const summary = progressRunning
            ? { label: '正在處理', tone: 'running', finished: false }
            : summarizeProgress(progressRows.map(row => row.state));
        const completionMessage = uploadCompletionMessage(progressOp, progressRows.map(row => row.state));
        const state = root?.querySelector('[data-field="progress-state-wrap"]');
        if (state) {
            state.className = `tr-progress-state tr-state-${summary.tone}`;
            state.innerHTML = `${progressSummaryIcon(summary.tone)}<b data-field="progress-state">${escapeHtml(summary.label)}</b>`;
        }
        if (resume) {
            resume.hidden = false;
            const label = resume.querySelector('[data-field="progress-resume-label"]');
            const button = resume.querySelector('[data-field="progress-resume-action"]');
            const bar = resume.querySelector('[data-field="progress-resume-bar"]');
            if (label)
                label.textContent = `${progressTitle}：${summary.label} · ${progressRatioLabel(settled, total)}`;
            if (button)
                button.textContent = summary.finished ? '查看結果' : '查看進度';
            if (bar)
                bar.style.width = `${pct}%`;
        }
        el.innerHTML = `
      <div class="tr-progress-head">
        <span class="tr-progress-title">${escapeHtml(progressTitle)}</span>
        <span class="tr-progress-count">${progressRatioLabel(settled, total)}</span>
      </div>
      <div class="tr-progressbar tr-progressbar-${summary.tone}"><i style="width:${pct}%"></i></div>
      <ul class="tr-progress-list">
        ${progressRows.map(renderProgressRow).join('')}
      </ul>
      ${completionMessage
            ? `<div class="tr-upload-complete"><i class="fa-solid fa-circle-check"></i><b>${completionMessage}</b></div>`
            : ''}
    `;
        applyConnectionGuards();
    }
    function beginProgress(op, title, rows) {
        if (blockNewProgressOperation()) {
            return false;
        }
        progressOp = op;
        progressTitle = title;
        progressRows = rows;
        progressRetryHandlers.clear();
        activeProgressTasks = 1;
        progressRunning = true;
        showScreen('progress');
        renderProgress();
        return true;
    }
    function beginProgressRetry(op) {
        if (progressOp !== op && !(op === 'backup' && progressOp === 'upload')) {
            setReport('這個重試已過期，請重新開始操作。');
            return false;
        }
        activeProgressTasks += 1;
        progressRunning = true;
        showScreen('progress');
        renderProgress();
        return true;
    }
    function finishProgressTask() {
        activeProgressTasks = Math.max(0, activeProgressTasks - 1);
        progressRunning = activeProgressTasks > 0;
        renderProgress();
    }
    function blockNewProgressOperation() {
        if (!progressRunning)
            return false;
        setReport('目前操作完成後，才能開始新的操作。');
        return true;
    }
    function showScreen(screen) {
        if (!root) {
            return;
        }
        if (screen === 'appearance' || currentScreen === 'appearance') {
            appearanceDraft = normalizeAppearance(options.getSettings().appearance);
            refreshAppearance();
            setText('appearance-feedback', '');
        }
        currentScreen = screen;
        for (const section of root.querySelectorAll('[data-screen]')) {
            section.hidden = section.dataset.screen !== screen;
        }
        root.querySelector('.tr-modal-content')?.scrollTo({ top: 0 });
        focusScreenHeading(screen);
    }
    function refreshAppearance() {
        if (!root)
            return;
        applyAppearance(root, appearanceDraft);
        for (const control of root.querySelectorAll('[data-appearance]')) {
            const field = control.dataset.appearance;
            control.value = field === 'accentColor' ? appearanceDraft.accentColor ?? '#8aa8ff'
                : field === 'mode' ? appearanceDraft.mode : appearanceDraft.tone;
        }
        for (const button of root.querySelectorAll('[data-accent]')) {
            button.setAttribute('aria-pressed', String(button.dataset.accent === (appearanceDraft.accentColor ?? 'default')));
        }
        setText('appearance-color', appearanceDraft.accentColor ?? '主題預設');
    }
    function focusScreenHeading(screen) {
        const currentRoot = root;
        if (!currentRoot)
            return;
        const targetWindow = getHostDocument().defaultView ?? window;
        const focus = () => {
            if (root !== currentRoot)
                return;
            currentRoot
                .querySelector(`[data-screen="${screen}"] h2`)
                ?.focus({ preventScroll: true });
        };
        if (typeof targetWindow.requestAnimationFrame === 'function') {
            targetWindow.requestAnimationFrame(focus);
        }
        else {
            targetWindow.setTimeout(focus, 0);
        }
    }
    function bindDialogKeyboard(hostDocument) {
        const onKeydown = (event) => {
            if (!root?.classList.contains('tr-floating') || event.defaultPrevented)
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                requestClose();
                return;
            }
            if (event.key !== 'Tab')
                return;
            const dialog = root.querySelector('.tr-modal');
            if (!dialog)
                return;
            const focusable = getFocusableElements(dialog);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus({ preventScroll: true });
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            const active = hostDocument.activeElement;
            if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
                event.preventDefault();
                first?.focus();
            }
        };
        hostDocument.addEventListener('keydown', onKeydown);
        removeKeyboardListener = () => hostDocument.removeEventListener('keydown', onKeydown);
    }
    async function showUploadConfirmation() {
        const requestRevision = ++uploadPreviewRevision;
        pendingUploadPreparation = null;
        showScreen('upload-confirm');
        const preview = root?.querySelector('[data-field="upload-preview"]');
        const uploadButton = root?.querySelector('[data-action="manual-upload"]');
        const environmentButton = root?.querySelector('[data-action="upload-with-environment"]');
        if (!preview || !uploadButton || !environmentButton) {
            return;
        }
        uploadButton.disabled = true;
        environmentButton.disabled = true;
        environmentButton.hidden = true;
        preview.setAttribute('aria-busy', 'true');
        preview.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin"></i> 正在確認雲端聊天與環境備份…</div>';
        try {
            const preparation = await options.onPrepareChatUpload();
            if (requestRevision !== uploadPreviewRevision || currentScreen !== 'upload-confirm' || !root)
                return;
            pendingUploadPreparation = preparation;
            preview.innerHTML = renderChatUploadPreparationHtml(preparation);
            const needsEnvironmentDecision = preparation.recoveryStatus !== 'ready';
            environmentButton.hidden = !needsEnvironmentDecision;
            uploadButton.querySelector('span').textContent = needsEnvironmentDecision ? '只上傳聊天' : '確認上傳';
            applyConnectionGuards();
        }
        catch (error) {
            if (requestRevision !== uploadPreviewRevision || currentScreen !== 'upload-confirm')
                return;
            preview.innerHTML = `<div class="tr-callout tr-danger"><b>無法確認雲端檔案：</b>${escapeHtml(panelController_errorMessage(error))}</div>`;
            uploadButton.title = '確認雲端檔案失敗，請稍後再試';
        }
        finally {
            if (requestRevision === uploadPreviewRevision)
                preview.setAttribute('aria-busy', 'false');
        }
    }
    async function showRestorePoints() {
        showScreen('restore-points');
        restorePointTarget = null;
        showRestorePointOverview();
        await loadRestorePointChats();
    }
    async function loadRestorePointChats() {
        const requestRevision = ++restorePointLoadRevision;
        const list = root?.querySelector('[data-field="restore-chat-list"]');
        if (!list)
            return;
        beginRestorePointLoad();
        setRestorePointFeedback('');
        list.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> 正在建立全部 _pre_restore 索引…</div>';
        try {
            const chats = await options.onListRestorePointChats();
            if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points')
                return;
            restorePointChats = chats;
            renderRestorePointChats();
        }
        catch (error) {
            if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points')
                return;
            restorePointChats = [];
            list.innerHTML = `<div class="tr-callout tr-danger"><b>無法載入還原點</b><br />${escapeHtml(panelController_errorMessage(error))}</div>`;
        }
        finally {
            finishRestorePointLoad();
        }
    }
    function renderRestorePointChats() {
        const list = root?.querySelector('[data-field="restore-chat-list"]');
        if (!list)
            return;
        const query = root?.querySelector('[data-field="restore-search"]')?.value.trim().toLocaleLowerCase() ?? '';
        const sort = root?.querySelector('[data-field="restore-sort"]')?.value ?? 'latest';
        const filtered = restorePointChats.filter(chat => !query || chat.roleKey.toLocaleLowerCase().includes(query) || chat.chatId.toLocaleLowerCase().includes(query));
        filtered.sort((left, right) => {
            if (sort === 'oldest')
                return (left.latestCreatedAt ?? '').localeCompare(right.latestCreatedAt ?? '');
            if (sort === 'count')
                return right.batchCount - left.batchCount;
            if (sort === 'name')
                return left.roleKey.localeCompare(right.roleKey) || left.chatId.localeCompare(right.chatId);
            return (right.latestCreatedAt ?? '').localeCompare(left.latestCreatedAt ?? '');
        });
        list.innerHTML = renderRestorePointChatListHtml(filtered);
    }
    function showRestorePointOverview() {
        restorePointTarget = null;
        const overview = root?.querySelector('[data-field="restore-overview"]');
        const detail = root?.querySelector('[data-field="restore-detail"]');
        if (overview)
            overview.hidden = false;
        if (detail)
            detail.hidden = true;
        updateRestorePointSelection();
        root?.querySelector('[data-field="restore-search"]')?.focus({ preventScroll: true });
    }
    async function openRestorePointChat(target) {
        restorePointTarget = target;
        const overview = root?.querySelector('[data-field="restore-overview"]');
        const detail = root?.querySelector('[data-field="restore-detail"]');
        if (overview)
            overview.hidden = true;
        if (detail)
            detail.hidden = false;
        setText('restore-detail-role', `角色：${target.roleKey}`);
        setText('restore-detail-chat', target.chatId);
        root?.querySelector('[data-field="restore-detail-chat"]')?.focus({ preventScroll: true });
        await loadRestorePointBatches(target);
    }
    async function loadRestorePointBatches(target = restorePointTarget) {
        if (!target)
            return;
        const requestRevision = ++restorePointLoadRevision;
        const list = root?.querySelector('[data-field="restore-point-list"]');
        if (!list)
            return;
        beginRestorePointLoad();
        setRestorePointFeedback('');
        list.innerHTML = '<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> 正在載入這個對話的完整 _pre_restore…</div>';
        try {
            const batches = await options.onListRestorePointBatches(target);
            if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points')
                return;
            restorePointBatches = batches;
            const available = new Set(batches.flatMap(batch => batch.files.map(file => file.fileId)));
            for (const [fileId, file] of selectedRestorePointFiles) {
                if (sameRestoreTarget(file, target) && !available.has(fileId))
                    selectedRestorePointFiles.delete(fileId);
            }
            list.innerHTML = renderRestorePointListHtml(batches, new Set(selectedRestorePointFiles.keys()));
            updateRestorePointSelection();
        }
        catch (error) {
            if (requestRevision !== restorePointLoadRevision || currentScreen !== 'restore-points')
                return;
            restorePointBatches = [];
            list.innerHTML = `<div class="tr-callout tr-danger"><b>無法載入還原點內容</b><br />${escapeHtml(panelController_errorMessage(error))}</div>`;
        }
        finally {
            finishRestorePointLoad();
        }
    }
    function updateRestorePointSelection() {
        if (!root)
            return;
        const files = [...root.querySelectorAll('[data-restore-file]')];
        const selected = files.filter(input => input.checked);
        const chatCount = new Set([...selectedRestorePointFiles.values()].map(file => JSON.stringify([file.roleKey, file.chatId]))).size;
        setText('restore-selection-count', `已選 ${selectedRestorePointFiles.size} 個檔案，來自 ${chatCount} 個對話`);
        const selectionBar = root.querySelector('[data-field="restore-selection"]');
        if (selectionBar)
            selectionBar.hidden = selectedRestorePointFiles.size === 0;
        const selectAll = root.querySelector('[data-action="select-all-restore-points"]');
        if (selectAll) {
            selectAll.checked = files.length > 0 && selected.length === files.length;
            selectAll.indeterminate = selected.length > 0 && selected.length < files.length;
        }
        applyConnectionGuards();
    }
    async function mutateSelectedRestorePoints(permanent) {
        if (restorePointControlsBlocked())
            return;
        const selected = [...selectedRestorePointFiles.values()];
        if (selected.length === 0)
            return;
        const summary = restorePointScopeSummary(selected);
        const verb = permanent ? '從 Google Drive 永久刪除' : '移到 Google Drive 垃圾桶';
        if (!confirmDestructive(`確定要${verb}已選內容嗎？\n\n${summary}\n\n${permanent ? '此操作無法復原。' : '之後仍可從 Drive 垃圾桶復原。'}`))
            return;
        await runRestorePointMutation(selected, permanent ? options.onDeleteRestorePointFilesPermanently : options.onTrashRestorePointFiles, permanent ? '永久刪除' : '移到垃圾桶');
    }
    async function cleanOldRestorePoints(days, scope) {
        if (!beginRestorePointDestructiveOperation())
            return;
        const target = scope === 'chat' ? restorePointTarget ?? undefined : undefined;
        setRestorePointFeedback(`正在掃描${scope === 'all' ? '全部對話' : '這個對話'}中超過 ${days} 天的檔案…`);
        try {
            const preview = await options.onPreviewRestorePointCleanup(days, target);
            if (preview.targets.length === 0) {
                setRestorePointFeedback(`沒有放入 _pre_restore 超過 ${days} 天的檔案。`);
                return;
            }
            const summary = `${preview.targets.length} 個檔案 · ${preview.batchCount} 個批次 · ${preview.chatCount} 個對話 · ${preview.roleCount} 個角色`;
            if (!confirmDestructive(`已找到放入 _pre_restore 超過 ${days} 天的內容：\n\n${summary}\n\n確定要移到 Google Drive 垃圾桶嗎？`)) {
                setRestorePointFeedback('已取消清理，沒有改動任何檔案。');
                return;
            }
            await performRestorePointMutation(preview.targets, options.onTrashRestorePointFiles, '移到垃圾桶');
        }
        catch (error) {
            setRestorePointFeedback(`清理失敗：${panelController_errorMessage(error)}`, true);
        }
        finally {
            finishRestorePointDestructiveOperation();
        }
    }
    async function runRestorePointMutation(selections, operation, actionLabel) {
        if (!beginRestorePointDestructiveOperation())
            return;
        try {
            await performRestorePointMutation(selections, operation, actionLabel);
        }
        finally {
            finishRestorePointDestructiveOperation();
        }
    }
    async function performRestorePointMutation(selections, operation, actionLabel) {
        setRestorePointFeedback(`正在${actionLabel}…`);
        try {
            const result = await operation(selections);
            const failedIds = new Set(result.failed.map(item => item.fileId));
            for (const selection of selections) {
                if (!failedIds.has(selection.fileId))
                    selectedRestorePointFiles.delete(selection.fileId);
            }
            await loadRestorePointChats();
            if (restorePointTarget)
                await loadRestorePointBatches(restorePointTarget);
            setRestorePointFeedback(result.failed.length === 0
                ? `已將 ${result.affected} 個遠端檔案${actionLabel}。`
                : `${result.affected} 個檔案已${actionLabel}，${result.failed.length} 個失敗。`, result.failed.length > 0);
        }
        catch (error) {
            setRestorePointFeedback(`${actionLabel}失敗：${panelController_errorMessage(error)}`, true);
        }
    }
    function beginRestorePointLoad() {
        activeRestorePointLoads += 1;
        applyConnectionGuards();
    }
    function finishRestorePointLoad() {
        activeRestorePointLoads = Math.max(0, activeRestorePointLoads - 1);
        applyConnectionGuards();
    }
    function beginRestorePointDestructiveOperation() {
        if (restorePointControlsBlocked())
            return false;
        restorePointDestructiveOperationRunning = true;
        applyConnectionGuards();
        return true;
    }
    function finishRestorePointDestructiveOperation() {
        restorePointDestructiveOperationRunning = false;
        applyConnectionGuards();
    }
    function restorePointControlsBlocked() {
        return !driveState.connected || activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning;
    }
    function setRestorePointFeedback(message, error = false) {
        const feedback = root?.querySelector('[data-field="restore-point-feedback"]');
        if (!feedback)
            return;
        feedback.textContent = message;
        feedback.classList.toggle('tr-state-error', error);
    }
    function confirmDestructive(message) {
        return (getHostDocument().defaultView ?? window).confirm(message);
    }
    /** 為指定 kinds 建立/重置進度列（重試時保留其他列）。 */
    function ensureRows(kinds) {
        for (const kind of kinds) {
            const existing = progressRows.find(row => row.key === kind);
            const fresh = { key: kind, label: environmentPresentation_environmentLabel(kind), state: 'pending', detail: '等待中', canRetry: false };
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
    async function runBackup(kinds, retry = false) {
        if (retry) {
            if (!beginProgressRetry('backup'))
                return;
        }
        else if (!beginProgress('backup', '備份完整環境', [])) {
            return;
        }
        ensureRows(kinds);
        for (const kind of kinds)
            progressRetryHandlers.set(kind, () => { void runBackup([kind], true); });
        renderProgress();
        try {
            const results = await options.onBackupEnvironment(kinds, applyBackupEvent);
            applyBackupResults(results);
        }
        catch (error) {
            for (const kind of kinds) {
                patchRow(kind, { state: 'error', detail: `失敗：${panelController_errorMessage(error)}`, canRetry: true });
            }
        }
        finally {
            finishProgressTask();
        }
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
    async function runRestore(kinds, retry = false) {
        if (retry) {
            if (!beginProgressRetry('restore'))
                return;
        }
        else if (!beginProgress('restore', '還原環境', [])) {
            return;
        }
        ensureRows(kinds);
        for (const kind of kinds)
            progressRetryHandlers.set(kind, () => { void runRestore([kind], true); });
        renderProgress();
        try {
            const result = await options.onRestoreEnvironment(kinds, applyRestoreEvent);
            applyRestoreResults(result.items);
        }
        catch (error) {
            for (const kind of kinds) {
                patchRow(kind, { state: 'error', detail: `失敗：${panelController_errorMessage(error)}`, canRetry: true });
            }
        }
        finally {
            finishProgressTask();
        }
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
            const detail = {
                backup_current: '備份現況…',
                download: '下載中…',
                validate: '驗證中…',
                check_context: '核對操作對象…',
                apply: '套用中…',
                export: '匯出中…',
                upload: '上傳中…'
            }[event.step];
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
                patchRow(item.kind, { state: 'aborted', detail: `已中止${item.error ? `：${item.error}` : ''}`, canRetry: true });
            }
            else {
                patchRow(item.kind, { state: 'error', detail: `失敗：${item.error ?? '未知錯誤'}`, canRetry: true });
            }
        }
    }
    async function runDownload(retry = false) {
        if (retry) {
            if (!beginProgressRetry('download'))
                return;
            patchRow('download', { state: 'active', detail: '正在建立還原點並更新…', canRetry: false });
        }
        else if (!beginProgress('download', '使用雲端最新版更新目前聊天', [{ key: 'download', label: '目前聊天', state: 'active', detail: '正在建立還原點並更新…', canRetry: false }])) {
            return;
        }
        progressRetryHandlers.set('download', () => { void runDownload(true); });
        try {
            const result = await options.onDownloadLatest();
            patchRow('download', {
                state: result.status === 'done' ? 'done' : 'warning',
                detail: result.detail,
                canRetry: false
            });
        }
        catch (error) {
            patchRow('download', { state: 'error', detail: `失敗：${panelController_errorMessage(error)}`, canRetry: true });
        }
        finally {
            finishProgressTask();
        }
    }
    async function runChatUpload(chatOnly) {
        if (blockNewProgressOperation())
            return;
        const preparation = pendingUploadPreparation;
        if (!preparation) {
            setReport('上傳確認已過期，請重新進入上傳確認頁');
            return;
        }
        const selectedEnvironment = chatOnly
            ? []
            : collectEnvironmentSelection(root?.querySelector('[data-screen="upload-confirm"]'), 'chat-upload');
        if (!chatOnly && selectedEnvironment.length === 0) {
            setReport('請先勾選至少一個環境項目，或選擇「只上傳聊天」');
            return;
        }
        const characterAvailable = preparation.environment.find(item => item.kind === 'character')?.available ?? false;
        const leavesCharacterMissing = !characterAvailable && !selectedEnvironment.includes('character');
        if (leavesCharacterMissing) {
            const confirmed = confirmDestructive('這次不會備份角色卡，其他裝置可能無法建立這段聊天。確定繼續嗎？');
            if (!confirmed)
                return;
        }
        const rows = [
            ...selectedEnvironment.map(kind => ({ key: kind, label: environmentPresentation_environmentLabel(kind), state: 'pending', detail: '等待中', canRetry: false })),
            { key: 'upload', label: '目前聊天', state: 'pending', detail: '等待環境備份', canRetry: false }
        ];
        if (!beginProgress('upload', chatOnly ? '上傳目前聊天' : '備份環境並上傳聊天', rows))
            return;
        pendingUploadPreparation = null;
        progressRetryHandlers.set('upload', () => { void showUploadConfirmation(); });
        for (const kind of selectedEnvironment) {
            progressRetryHandlers.set(kind, () => { void runBackup([kind], true); });
        }
        patchRow('upload', { state: selectedEnvironment.length ? 'pending' : 'active', detail: selectedEnvironment.length ? '等待環境備份' : '上傳中…' });
        try {
            const result = await options.onConfirmChatUpload({
                preparationId: preparation.preparationId,
                selectedEnvironment,
                chatOnly
            }, applyBackupEvent);
            applyBackupResults(result.environmentResults);
            if (!result.chat) {
                patchRow('upload', { state: 'aborted', detail: '角色卡備份失敗，已保留聊天未上傳', canRetry: true });
            }
            else if (result.chat.status === 'queued') {
                patchRow('upload', { state: 'queued', detail: result.chat.detail, canRetry: false });
            }
            else {
                patchRow('upload', { state: 'done', detail: result.chat.detail, canRetry: false });
            }
        }
        catch (error) {
            patchRow('upload', { state: 'error', detail: `失敗：${panelController_errorMessage(error)}`, canRetry: true });
        }
        finally {
            finishProgressTask();
        }
    }
    async function showCloudRoles() {
        const el = root?.querySelector('[data-field="cloud-list"]');
        if (!el) {
            return;
        }
        el.hidden = false;
        el.innerHTML = '<p class="tr-cloud-empty">載入中…</p>';
        try {
            el.innerHTML = renderCloudRoleListHtml(await options.onListCloudRoles());
        }
        catch (error) {
            el.innerHTML = `<p class="tr-cloud-empty">讀取失敗：${escapeHtml(panelController_errorMessage(error))}</p>`;
        }
    }
    async function showCloudChats(roleKey) {
        const el = root?.querySelector('[data-field="cloud-list"]');
        if (!el) {
            return;
        }
        el.innerHTML = '<p class="tr-cloud-empty">載入中…</p>';
        try {
            el.innerHTML = renderCloudChatListHtml(roleKey, await options.onListCloudChats(roleKey));
        }
        catch (error) {
            el.innerHTML = `<p class="tr-cloud-empty">讀取失敗：${escapeHtml(panelController_errorMessage(error))}</p>`;
        }
    }
    async function runPull(roleKey, chatId, retry = false) {
        if (retry) {
            if (!beginProgressRetry('pull'))
                return;
            patchRow('pull', { state: 'active', detail: '建立中…', canRetry: false });
        }
        else if (!beginProgress('pull', '從雲端建立聊天', [
            { key: 'pull', label: chatId, state: 'active', detail: '建立中…', canRetry: false }
        ])) {
            return;
        }
        progressRetryHandlers.set('pull', () => { void runPull(roleKey, chatId, true); });
        try {
            const result = await options.onPullChat(roleKey, chatId);
            patchRow('pull', {
                state: 'done',
                detail: `已建立 ${result.chatFileName}（來源 ${result.filename}）`,
                canRetry: false
            });
        }
        catch (error) {
            patchRow('pull', { state: 'error', detail: `失敗：${panelController_errorMessage(error)}`, canRetry: true });
        }
        finally {
            finishProgressTask();
        }
    }
    async function previewRestore(items) {
        if (!root || restorePreviewLoading || blockNewProgressOperation()) {
            return;
        }
        pendingRestoreItems = items;
        restorePreviewReady = false;
        restorePreviewLoading = true;
        showScreen('restore-confirm');
        const preview = root.querySelector('[data-field="restore-preview"]');
        const retry = root.querySelector('[data-action="retry-restore-preview"]');
        if (preview) {
            preview.setAttribute('aria-busy', 'true');
            preview.innerHTML = `<div class="tr-callout"><i class="fa-solid fa-spinner fa-spin"></i> 正在檢查 ${items.length} 個項目的雲端備份…</div>`;
        }
        if (retry) {
            retry.disabled = true;
            retry.hidden = true;
        }
        applyConnectionGuards();
        try {
            const cloudFiles = await options.onPreviewRestore(items);
            if (!root)
                return;
            const currentPreview = root.querySelector('[data-field="restore-preview"]');
            if (currentPreview)
                currentPreview.innerHTML = renderRestorePreviewHtml(cloudFiles, items);
            restorePreviewReady = true;
        }
        catch (error) {
            if (!root)
                return;
            const currentPreview = root.querySelector('[data-field="restore-preview"]');
            const currentRetry = root.querySelector('[data-action="retry-restore-preview"]');
            if (currentPreview)
                currentPreview.innerHTML = renderRestorePreviewErrorHtml(panelController_errorMessage(error));
            if (currentRetry)
                currentRetry.hidden = false;
        }
        finally {
            restorePreviewLoading = false;
            root?.querySelector('[data-field="restore-preview"]')?.setAttribute('aria-busy', 'false');
            applyConnectionGuards();
        }
    }
    function requestClose() {
        if (progressRunning) {
            const targetWindow = getHostDocument().defaultView ?? window;
            const confirmed = targetWindow.confirm('操作仍在進行中。關閉面板後會在背景繼續，稍後可重新開啟查看進度。確定關閉嗎？');
            if (!confirmed)
                return;
        }
        unmount();
        options.onClose?.();
    }
    async function runSystemCheck(mode) {
        if (selfCheckRunning)
            return;
        if (mode === 'advanced') {
            const targetWindow = getHostDocument().defaultView ?? window;
            const confirmed = targetWindow.confirm('進階診斷可能建立暫存角色卡或短暫修改專用測試聊天。請先停用自動同步，且只在測試資料上執行。確定繼續嗎？');
            if (!confirmed)
                return;
        }
        selfCheckRunning = true;
        selfCheckMode = mode;
        selfCheckProgress = null;
        selfCheckResults = [];
        renderSelfCheckArea();
        try {
            selfCheckResults = await options.onRunSelfChecks(mode, progress => {
                selfCheckProgress = progress;
                if (progress.result)
                    selfCheckResults = [...selfCheckResults, progress.result];
                renderSelfCheckArea();
            });
        }
        catch (error) {
            setReport(`系統檢查失敗：${panelController_errorMessage(error)}`);
        }
        finally {
            selfCheckRunning = false;
            selfCheckProgress = null;
            renderSelfCheckArea();
        }
    }
    function renderSelfCheckArea() {
        const container = root?.querySelector('[data-field="self-check-results"]');
        if (!container)
            return;
        container.innerHTML = renderSelfCheckResultsHtml(selfCheckResults, {
            mode: selfCheckMode,
            running: selfCheckRunning,
            progress: selfCheckProgress
        });
        for (const button of root?.querySelectorAll('[data-self-check-mode]') ?? []) {
            button.disabled = selfCheckRunning;
        }
    }
    async function copySelfCheckReport() {
        if (selfCheckResults.length === 0)
            return;
        const clipboard = (getHostDocument().defaultView ?? window).navigator.clipboard;
        if (!clipboard?.writeText) {
            setReport('此瀏覽器無法直接複製，請展開各項「技術資訊」手動複製。');
            return;
        }
        try {
            await clipboard.writeText(buildSelfCheckReport(selfCheckResults));
            setReport('診斷報告已複製，敏感欄位已遮蔽');
        }
        catch (error) {
            setReport(`複製診斷報告失敗：${panelController_errorMessage(error)}`);
        }
    }
    function retryRow(key) {
        progressRetryHandlers.get(key)?.();
    }
    // ── 事件綁定 ───────────────────────────────────────────────────
    function bindEvents() {
        if (!root)
            return;
        for (const link of root.querySelectorAll('[data-external-link]')) {
            link.addEventListener('click', event => {
                // SillyTavern uses the surrounding drawer header as a collapse toggle.
                // Opening help must not also collapse the TavernRoamer panel.
                event.stopPropagation();
            });
        }
        for (const control of root.querySelectorAll('[data-appearance]')) {
            const previewChange = () => {
                const field = control.dataset.appearance;
                if (field !== 'mode' && field !== 'tone' && field !== 'accentColor')
                    return;
                appearanceDraft = normalizeAppearance({ ...appearanceDraft, [field]: control.value });
                refreshAppearance();
                setText('appearance-feedback', '預覽中，按「儲存外觀」保留變更。');
            };
            control.addEventListener('input', previewChange);
            control.addEventListener('change', previewChange);
        }
        for (const button of root.querySelectorAll('[data-accent]')) {
            button.addEventListener('click', () => {
                appearanceDraft = normalizeAppearance({ ...appearanceDraft, accentColor: button.dataset.accent });
                refreshAppearance();
                setText('appearance-feedback', '預覽中，按「儲存外觀」保留變更。');
            });
        }
        root.querySelector('[data-action="reset-appearance"]')?.addEventListener('click', () => {
            appearanceDraft = { ...defaultAppearance };
            refreshAppearance();
            setText('appearance-feedback', '已預覽預設外觀，儲存後套用。');
        });
        root.querySelector('[data-action="save-appearance"]')?.addEventListener('click', () => {
            const saved = options.saveSettings({ ...options.getSettings(), appearance: appearanceDraft });
            options.onSave(saved);
            appearanceDraft = normalizeAppearance(saved.appearance);
            refreshAppearance();
            setText('appearance-feedback', '外觀已儲存。');
        });
        root.addEventListener('click', event => {
            if (event.target === root && root?.classList.contains('tr-floating')) {
                requestClose();
                return;
            }
            const navigation = event.target?.closest('[data-navigate]');
            const screen = navigation?.dataset.navigate;
            if (screen) {
                event.stopPropagation();
                if (screen === 'upload-confirm') {
                    void showUploadConfirmation();
                }
                else if (screen === 'restore-points') {
                    void showRestorePoints();
                }
                else {
                    showScreen(screen);
                }
                return;
            }
            // 狀態卡的按鈕會隨 updateContext 重繪，因此以事件委派處理。
            const homeAction = event.target
                ?.closest('[data-action="refresh-status"], [data-action="flush-queue"]');
            if (!homeAction || homeAction.disabled)
                return;
            event.stopPropagation();
            if (homeAction.dataset.action === 'refresh-status')
                void refreshStatus();
            else
                void flushQueue();
        });
        root.querySelector('[data-action="close-panel"]')?.addEventListener('click', event => {
            event.stopPropagation();
            requestClose();
        });
        root.querySelector('[data-action="save"]')?.addEventListener('click', () => {
            if (!root)
                return;
            const settings = collectSettings(root, options.getSettings());
            const saved = options.saveSettings(settings);
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
                const saved = options.saveSettings(collectSettings(root, options.getSettings()));
                options.onSave(saved);
                refreshSettingsGuidance(saved);
                const state = await options.onConnectDrive();
                updateDriveStatus(state);
                setReport(state.connected ? 'Google Drive 已連線' : `Google Drive 未連線：${state.error ?? '未知錯誤'}`);
                if (state.connected) {
                    showScreen('home');
                }
            }
            catch (error) {
                updateDriveStatus({ connected: false, email: null, error: panelController_errorMessage(error) });
                setReport(panelController_errorMessage(error));
            }
        });
        root.querySelector('[data-action="manual-upload"]')?.addEventListener('click', () => {
            void runChatUpload(true);
        });
        root.querySelector('[data-action="upload-with-environment"]')?.addEventListener('click', () => {
            void runChatUpload(false);
        });
        root.querySelector('[data-action="download-latest"]')?.addEventListener('click', () => {
            void runDownload();
        });
        root.querySelector('[data-action="browse-cloud"]')?.addEventListener('click', () => {
            showScreen('cloud');
            void showCloudRoles();
        });
        root.querySelector('[data-field="cloud-list"]')?.addEventListener('click', async (event) => {
            const target = event.target;
            const roleButton = target?.closest('[data-cloud-role]');
            if (roleButton) {
                await showCloudChats(roleButton.getAttribute('data-cloud-role') ?? '');
                return;
            }
            if (target?.closest('[data-cloud-back]')) {
                await showCloudRoles();
                return;
            }
            const pullButton = target?.closest('[data-cloud-pull-role]');
            if (!pullButton || pullButton.hasAttribute('disabled')) {
                return;
            }
            const roleKey = pullButton.getAttribute('data-cloud-pull-role') ?? '';
            const chatId = pullButton.getAttribute('data-cloud-pull-chat') ?? '';
            lastPullTarget = { roleKey, chatId };
            setText('pull-role', roleKey);
            setText('pull-chat', chatId);
            showScreen('cloud-confirm');
        });
        root.querySelector('[data-action="confirm-cloud-pull"]')?.addEventListener('click', async () => {
            if (lastPullTarget) {
                await runPull(lastPullTarget.roleKey, lastPullTarget.chatId);
            }
        });
        root.querySelector('[data-action="backup-environment"]')?.addEventListener('click', () => {
            const selectedItems = collectEnvironmentSelection(root?.querySelector('[data-screen="environment-backup"]'), 'environment-backup');
            if (selectedItems.length === 0) {
                setReport('請先勾選至少一個環境項目');
                return;
            }
            void runBackup(selectedItems);
        });
        root.querySelector('[data-action="restore-environment"]')?.addEventListener('click', async () => {
            const selectedItems = collectEnvironmentSelection(root?.querySelector('[data-screen="environment-restore"]'), 'environment-restore');
            if (selectedItems.length === 0) {
                setReport('請先勾選至少一個環境項目');
                return;
            }
            await previewRestore(selectedItems);
        });
        root.querySelector('[data-action="retry-restore-preview"]')?.addEventListener('click', () => {
            void previewRestore(pendingRestoreItems);
        });
        root.querySelector('[data-action="confirm-restore"]')?.addEventListener('click', () => {
            if (pendingRestoreItems.length > 0) {
                void runRestore(pendingRestoreItems);
            }
        });
        root.querySelector('[data-action="refresh-restore-points"]')?.addEventListener('click', () => {
            if (restorePointTarget)
                void loadRestorePointBatches();
            else
                void loadRestorePointChats();
        });
        root.querySelector('[data-field="restore-search"]')?.addEventListener('input', renderRestorePointChats);
        root.querySelector('[data-field="restore-sort"]')?.addEventListener('change', renderRestorePointChats);
        root.querySelector('[data-field="restore-chat-list"]')?.addEventListener('click', event => {
            const button = event.target?.closest('[data-restore-chat]');
            const roleKey = button?.dataset.roleKey;
            const chatId = button?.dataset.chatId;
            if (roleKey && chatId)
                void openRestorePointChat({ roleKey, chatId });
        });
        root.querySelector('[data-action="back-to-restore-chats"]')?.addEventListener('click', showRestorePointOverview);
        root.querySelector('[data-action="select-all-restore-points"]')?.addEventListener('change', event => {
            const checked = event.currentTarget.checked;
            const available = new Map(restorePointBatches.flatMap(batch => batch.files).map(file => [file.fileId, file]));
            for (const input of root?.querySelectorAll('[data-restore-file]') ?? []) {
                input.checked = checked;
                const fileId = input.dataset.restoreFile;
                const file = fileId ? available.get(fileId) : undefined;
                if (!fileId)
                    continue;
                if (checked && file)
                    selectedRestorePointFiles.set(fileId, file);
                else
                    selectedRestorePointFiles.delete(fileId);
            }
            updateRestorePointSelection();
        });
        root.querySelector('[data-field="restore-point-list"]')?.addEventListener('change', event => {
            const input = event.target?.closest('[data-restore-file]');
            const fileId = input?.dataset.restoreFile;
            if (!input || !fileId)
                return;
            const file = restorePointBatches.flatMap(batch => batch.files).find(item => item.fileId === fileId);
            if (input.checked && file)
                selectedRestorePointFiles.set(fileId, file);
            else
                selectedRestorePointFiles.delete(fileId);
            updateRestorePointSelection();
        });
        root.querySelector('[data-action="trash-selected-restore-points"]')?.addEventListener('click', () => {
            void mutateSelectedRestorePoints(false);
        });
        root.querySelector('[data-action="delete-selected-restore-points-permanently"]')?.addEventListener('click', () => {
            void mutateSelectedRestorePoints(true);
        });
        for (const button of root.querySelectorAll('[data-restore-age]')) {
            button.addEventListener('click', () => {
                const days = Number(button.dataset.restoreAge);
                const scope = button.dataset.restoreScope;
                if ((days === 15 || days === 30) && (scope === 'all' || scope === 'chat'))
                    void cleanOldRestorePoints(days, scope);
            });
        }
        root.querySelector('[data-self-check-mode="quick"]')?.addEventListener('click', () => {
            void runSystemCheck('quick');
        });
        root.querySelector('[data-self-check-mode="advanced"]')?.addEventListener('click', () => {
            void runSystemCheck('advanced');
        });
        root.querySelector('[data-field="self-check-results"]')?.addEventListener('click', event => {
            const action = event.target?.closest('[data-self-check-action]')
                ?.dataset.selfCheckAction;
            if (action === 'connect_drive') {
                root?.querySelector('[data-action="connect-drive"]')?.click();
            }
            else if (action === 'open_settings') {
                showScreen('settings');
            }
            else if (action === 'copy_report') {
                void copySelfCheckReport();
            }
        });
        // 進度清單「重試」以事件委派處理（每次 renderProgress 會重寫 innerHTML）
        root.querySelector('[data-field="progress"]')?.addEventListener('click', event => {
            const target = event.target?.closest('[data-retry-key]');
            const key = target?.getAttribute('data-retry-key');
            if (key) {
                retryRow(key);
            }
        });
    }
    /**
     * 所有需要 Drive 或受進度鎖影響的按鈕，停用狀態都只在這裡計算，
     * 避免某條路徑把其他條件要求停用的按鈕重新啟用。
     */
    function applyConnectionGuards() {
        if (!root) {
            return;
        }
        for (const button of root.querySelectorAll('[data-drive-required]')) {
            const reason = buttonBlockedReason(button);
            button.disabled = reason !== null;
            button.classList.toggle('tr-disabled', reason !== null);
            if (reason)
                button.title = reason;
            else
                button.removeAttribute('title');
        }
        const restorePointControlsDisabled = restorePointControlsBlocked();
        for (const control of root.querySelectorAll('[data-restore-file], [data-restore-chat], [data-action="back-to-restore-chats"], [data-field="restore-search"], [data-field="restore-sort"]')) {
            control.disabled = restorePointControlsDisabled;
        }
        const selectAll = root.querySelector('[data-action="select-all-restore-points"]');
        if (selectAll) {
            const hasFiles = root.querySelector('[data-restore-file]') !== null;
            selectAll.disabled = restorePointControlsDisabled || !hasFiles;
        }
        const restorePointBusy = activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning;
        root.querySelector('[data-field="restore-point-list"]')?.setAttribute('aria-busy', String(restorePointBusy));
        root.querySelector('[data-field="restore-chat-list"]')?.setAttribute('aria-busy', String(restorePointBusy));
    }
    /** 回傳停用原因；null 表示可用，空字串表示停用但不顯示提示。 */
    function buttonBlockedReason(button) {
        const action = button.dataset.action ?? '';
        if (!driveState.connected)
            return DRIVE_GUARD_TITLE;
        const isSelectionAction = RESTORE_POINT_SELECTION_ACTIONS.has(action);
        if (isSelectionAction || button.hasAttribute('data-restore-age') || action === 'refresh-restore-points') {
            // 還原點管理不受進度鎖影響，只看自己的忙碌狀態與選取數量。
            if (activeRestorePointLoads > 0 || restorePointDestructiveOperationRunning)
                return '正在處理還原點，請稍候';
            if (isSelectionAction && selectedRestorePointFiles.size === 0)
                return '請先勾選還原點檔案';
            return null;
        }
        if (action === 'refresh-status' && statusRefreshRunning)
            return '';
        if (action === 'flush-queue' && queueFlushRunning)
            return '';
        if (progressRunning && (button.hasAttribute('data-home-task') || PROGRESS_START_ACTIONS.has(action))) {
            return PROGRESS_LOCK_TITLE;
        }
        if (action === 'confirm-restore' && (!restorePreviewReady || restorePreviewLoading))
            return '請先完成雲端備份檢查';
        if (action === 'retry-restore-preview' && restorePreviewLoading)
            return '';
        if ((action === 'manual-upload' || action === 'upload-with-environment') && !pendingUploadPreparation) {
            return '請先完成上傳前檢查';
        }
        return null;
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
    function setText(field, value) {
        for (const el of root?.querySelectorAll(`[data-field="${field}"]`) ?? []) {
            el.textContent = value;
        }
    }
    function setReport(text) {
        const report = root?.querySelector('[data-field="report"]');
        if (report) {
            report.textContent = text;
        }
    }
    return { mount, unmount, updateContext, updateDriveStatus, invalidateUploadPreparation, probe };
}
function panelController_errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function sameRestoreTarget(left, right) {
    return left.roleKey === right.roleKey && left.chatId === right.chatId;
}
function restorePointScopeSummary(files) {
    const roles = new Set(files.map(file => file.roleKey)).size;
    const chats = new Set(files.map(file => JSON.stringify([file.roleKey, file.chatId]))).size;
    const batches = new Set(files.map(file => file.batchFolderId)).size;
    return `${files.length} 個檔案 · ${batches} 個批次 · ${chats} 個對話 · ${roles} 個角色`;
}
function collectSettings(root, current) {
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
function progressSummaryIcon(tone) {
    switch (tone) {
        case 'running':
            return '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
        case 'success':
            return '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>';
        case 'warning':
            return '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
        case 'error':
            return '<i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>';
        case 'neutral':
        default:
            return '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>';
    }
}

;// ./src/ui.ts


;// ./src/index.ts




















const LAUNCHER_ID = 'tavern-roamer-launcher';
const LAUNCHER_LABEL = 'TavernRoamer';
const LAUNCHER_RETRY_MS = 500;
const tavernServices = createTavernServices();
registerPhase0SelfChecks();
registerApiSpikeSelfChecks(tavernServices);
registerChatSelfChecks(tavernServices);
registerPullSelfChecks(tavernServices);
const tavern = tavernServices.shell;
const auth = new GoogleIdentityAuth(() => loadSettings().googleClientId);
const driveClient = new GoogleDriveClient({ tokenProvider: auth });
const driveService = new DriveService(driveClient);
const chatSync = new ChatSyncService(tavernServices.chatSync, driveService);
const environmentBackup = new EnvironmentBackupService(tavernServices.environment, driveService);
const environmentRestore = new EnvironmentRestoreService(tavernServices.environment, driveService);
const chatUploadReadiness = new ChatUploadReadinessService(driveService);
const chatUploadWorkflow = new ChatUploadWorkflow(chatSync, environmentBackup, chatUploadReadiness);
const restorePoints = new RestorePointService(driveService);
const chatPull = new ChatPullService(tavernServices.chatPull, driveService);
let driveState = { connected: false, email: null, error: null };
let panelRefreshRevision = 0;
let launcherRetryId = null;
registerDriveSelfChecks(driveService, () => driveState);
const panel = createPanel({
    getContext: () => tavern.getContext(),
    getDriveState: () => driveState,
    getSettings: loadSettings,
    saveSettings: saveSettings,
    onRunSelfChecks: (mode, onProgress) => runSelfChecks({ mode, onProgress }),
    onSave: () => tavern.notify('設定已儲存', 'success'),
    onConnectDrive: async () => {
        await auth.connect();
        const email = await driveClient.getAccountEmail();
        driveState = { connected: true, email, error: null };
        await chatSync.flushQueue();
        await refreshPanelContext();
        return driveState;
    },
    onRefreshStatus: () => refreshPanelContext(),
    onFlushQueue: async () => {
        try {
            return await chatSync.flushQueue();
        }
        finally {
            await refreshPanelContext();
        }
    },
    onPrepareChatUpload: async () => {
        const preparation = await chatUploadWorkflow.prepare();
        return {
            preparationId: preparation.preparationId,
            isFirstUpload: preparation.isFirstUpload,
            latestChatFilename: preparation.latestChatFilename,
            environment: preparation.environment,
            recoveryStatus: preparation.recoveryStatus
        };
    },
    onConfirmChatUpload: async (request, onProgress) => {
        const result = await chatUploadWorkflow.execute({ ...request, onProgress });
        await refreshPanelContext();
        if (!result.chatResult) {
            tavern.notify('角色卡備份失敗，為避免產生無法在遠端建立的聊天，本次未上傳聊天', 'warning');
            return { ...result, chat: null };
        }
        const upload = result.chatResult;
        const cloudPath = formatCloudPath(upload.path, upload.filename);
        const detail = upload.queued
            ? `已加入待傳佇列：${cloudPath}`
            : upload.cleanup === 'pending'
                ? `${cloudPath}（聊天已上傳；舊版本清理待重試）`
                : upload.metadata !== 'applied'
                    ? `${cloudPath}（聊天已上傳；同步狀態延後更新）`
                    : cloudPath;
        const environmentFailed = result.environmentResults.filter(item => item.status === 'error').length;
        if (upload.queued) {
            tavern.notify(`上傳未完成，已加入待傳佇列：${cloudPath}`, 'warning');
        }
        else if (result.status === 'partial') {
            tavern.notify(environmentFailed > 0 ? `聊天已上傳，${environmentFailed} 項環境備份失敗` : detail, 'warning');
        }
        else if (result.recoveryStatus === 'missing_character') {
            tavern.notify(`聊天已上傳，但雲端仍缺少角色卡：${cloudPath}`, 'warning');
        }
        else {
            tavern.notify(`目前聊天已上傳：${cloudPath}`, 'success');
        }
        return {
            status: result.status,
            environmentResults: result.environmentResults,
            recoveryStatus: result.recoveryStatus,
            chat: {
                status: upload.queued ? 'queued' : result.status === 'partial' ? 'partial' : 'done',
                detail
            }
        };
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
        const preview = Object.fromEntries(ENVIRONMENT_ITEM_KINDS.map(kind => [kind, null]));
        for (const kind of items) {
            const versions = await environmentBackup.listItemVersions(kind);
            preview[kind] = versions.at(-1)?.filename ?? null;
        }
        return preview;
    },
    onDownloadLatest: async () => {
        const result = await chatSync.downloadLatestAndReplace();
        await refreshPanelContext();
        const detail = result.status === 'done'
            ? `已更新為 ${result.filename}`
            : `聊天已更新為 ${result.filename}，但同步狀態尚待核對`;
        tavern.notify(result.status === 'done' ? '已使用雲端最新版更新目前聊天' : detail, result.status === 'done' ? 'success' : 'warning');
        return { filename: result.filename, status: result.status, detail };
    },
    onListCloudRoles: () => listCloudRoles(driveService),
    onListCloudChats: roleKey => listCloudChats(driveService, roleKey),
    onPullChat: async (roleKey, chatId) => {
        const result = await chatPull.pullChat(roleKey, chatId);
        await refreshPanelContext();
        tavern.notify(result.characterRestored ? '已還原角色卡並建立聊天' : '已從雲端建立聊天', 'success');
        return result;
    },
    onListRestorePointChats: () => restorePoints.listChats(),
    onListRestorePointBatches: target => restorePoints.listChat(target),
    onPreviewRestorePointCleanup: (days, target) => restorePoints.previewCleanup(days, target),
    onTrashRestorePointFiles: async (files) => {
        const result = await restorePoints.trashFiles(files);
        tavern.notify(result.failed.length === 0
            ? `已將 ${result.affected} 個還原點檔案移到 Drive 垃圾桶`
            : `${result.affected} 個檔案已移到垃圾桶，${result.failed.length} 個失敗`, result.failed.length === 0 ? 'success' : 'warning');
        return result;
    },
    onDeleteRestorePointFilesPermanently: async (files) => {
        const result = await restorePoints.deleteFilesPermanently(files);
        tavern.notify(result.failed.length === 0
            ? `已永久刪除 ${result.affected} 個還原點檔案`
            : `${result.affected} 個檔案已永久刪除，${result.failed.length} 個失敗`, result.failed.length === 0 ? 'success' : 'warning');
        return result;
    }
});
const autoSync = new AutoSyncController({
    upload: async (target) => {
        try {
            await chatSync.uploadChat(target, { queueOnFail: true });
            await refreshPanelContext();
        }
        catch (error) {
            tavern.notify(error instanceof Error ? error.message : String(error), 'warning');
        }
    }
});
async function refreshPanelContext() {
    const revision = ++panelRefreshRevision;
    const context = tavern.getContext();
    try {
        const meta = tavern.getChatMeta();
        const pendingUploads = countQueuedUploadsForChat(meta);
        let remoteCheckFailed = false;
        let localCheckFailed = false;
        const [remoteState, localContentHash] = await Promise.all([
            driveState.connected && meta
                ? chatSync.getRemoteVersionState(meta).catch(() => {
                    remoteCheckFailed = true;
                    return { latestFilename: null, baselineFound: false };
                })
                : Promise.resolve({ latestFilename: null, baselineFound: false }),
            meta
                ? chatSync.getCurrentContentHash().catch(() => {
                    localCheckFailed = true;
                    return null;
                })
                : Promise.resolve(null)
        ]);
        if (revision !== panelRefreshRevision)
            return;
        panel.updateContext({
            ...context,
            status: computeSyncStatus({
                connected: driveState.connected,
                meta,
                remoteLatestFilename: remoteState.latestFilename,
                remoteBaselineFound: remoteState.baselineFound,
                localContentHash,
                remoteCheckFailed,
                localCheckFailed,
                pendingUploads,
                localMessageCount: context.lastMessageId === null ? 0 : context.lastMessageId + 1
            })
        }, { lastSyncedVersion: meta?.last_synced_version ?? null, pendingUploads });
    }
    catch {
        if (revision !== panelRefreshRevision)
            return;
        panel.updateContext({ ...context, status: driveState.connected ? 'check_failed' : 'not_connected' }, { lastSyncedVersion: null, pendingUploads: 0 });
    }
}
function markCurrentChatContentChanged() {
    try {
        const context = tavern.getContext();
        const meta = tavern.getChatMeta();
        panel.updateContext({
            ...context,
            status: !driveState.connected
                ? 'not_connected'
                : meta?.last_synced_version
                    ? 'local_dirty'
                    : 'untracked'
        }, {
            lastSyncedVersion: meta?.last_synced_version ?? null,
            pendingUploads: countQueuedUploadsForChat(meta)
        });
    }
    catch {
        // 無法安全辨識目前聊天時，等待下一次完整刷新。
    }
}
async function applyPendingReceiptsAndRefresh() {
    try {
        await chatSync.applyPendingReceiptsForCurrent();
    }
    catch {
        // 尚未載入聊天或 receipt 暫時無法核對時，仍刷新目前可取得的狀態。
    }
    await refreshPanelContext();
}
function boot() {
    globalThis.__tavernRoamerBooted = true;
    console.info('[TavernRoamer] booting background services');
    removeLegacyScriptButton();
    ensureLauncherButton();
    void auth.preload().catch(() => undefined);
    void applyPendingReceiptsAndRefresh();
    panel.updateDriveStatus(driveState);
    const offChatChanged = tavern.onChatChanged(chatFileName => {
        markContextChanged();
        chatUploadWorkflow.invalidateAll();
        panel.invalidateUploadPreparation();
        tavern.getContext(chatFileName);
        void applyPendingReceiptsAndRefresh();
    });
    const offChatContentChanged = tavern.onChatContentChanged(markCurrentChatContentChanged);
    const offMessageCompleted = tavern.onMessageCompleted(() => {
        try {
            autoSync.handleMessageCompleted(chatSync.captureCurrentChat());
        }
        catch {
            // 沒有可辨識的目前聊天時不建立自動同步工作。
        }
    });
    window.addEventListener('pagehide', () => {
        offChatChanged();
        offChatContentChanged();
        offMessageCompleted();
        autoSync.stop();
        if (launcherRetryId)
            window.clearTimeout(launcherRetryId);
        panel.unmount();
        src_getHostDocument().getElementById(LAUNCHER_ID)?.remove();
    }, { once: true });
}
function openPanel() {
    panel.mount({ floating: true });
    panel.updateDriveStatus(driveState);
    void refreshPanelContext();
}
function removeLegacyScriptButton() {
    const globals = globalThis;
    if (typeof globals.updateScriptButtonsWith !== 'function') {
        return;
    }
    try {
        const result = globals.updateScriptButtonsWith((buttons) => buttons.filter(button => button.name !== LAUNCHER_LABEL));
        if (result && typeof result.catch === 'function') {
            void result.catch(() => undefined);
        }
    }
    catch {
        // 舊版酒館助手沒有可用的腳本按鈕更新 API 時，保持魔法棒入口即可。
    }
}
function ensureLauncherButton() {
    const hostDocument = src_getHostDocument();
    const menu = hostDocument.querySelector('#extensionsMenu');
    if (!menu) {
        launcherRetryId = window.setTimeout(ensureLauncherButton, LAUNCHER_RETRY_MS);
        return;
    }
    launcherRetryId = null;
    if (hostDocument.getElementById(LAUNCHER_ID)) {
        return;
    }
    const launcher = hostDocument.createElement('div');
    launcher.id = LAUNCHER_ID;
    launcher.className = 'interactable';
    launcher.tabIndex = 0;
    launcher.setAttribute('role', 'button');
    launcher.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>${LAUNCHER_LABEL}</span>`;
    launcher.addEventListener('click', openPanel);
    launcher.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPanel();
        }
    });
    menu.append(launcher);
    console.info('[TavernRoamer] launcher added to the magic-wand menu');
}
function src_getHostDocument() {
    try {
        return globalThis.parent?.document ?? document;
    }
    catch {
        return document;
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
}
else {
    boot();
}
function formatCloudPath(path, filename) {
    return [...path, filename].join(' / ');
}


//# sourceMappingURL=tavern-roamer.js.map
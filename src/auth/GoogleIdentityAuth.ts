const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_SKEW_MS = 60_000;
const AUTH_POPUP_TIMEOUT_MS = 120_000;
const POPUP_CLOSED_GRACE_MS = 2_000;

export type GoogleIdentityAuthState = {
  connected: boolean;
  expiresAt: number | null;
  error: string | null;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type TokenError = {
  type?: string;
  message?: string;
};

type TokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
};

type GoogleIdentityHost = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient?: (config: {
          client_id: string;
          scope: string;
          callback: (response: TokenResponse) => void;
          error_callback: (error: TokenError) => void;
        }) => TokenClient;
      };
    };
  };
};

export class GoogleIdentityAuth {
  private tokenClient: TokenClient | null = null;
  private tokenClientClientId = '';
  private accessToken: string | null = null;
  private expiresAt = 0;
  private pendingRequest: Promise<string> | null = null;
  private lastError: string | null = null;
  private oauthHost: Window = getOAuthHostWindow();

  constructor(private getClientId: () => string) {}

  getState(): GoogleIdentityAuthState {
    return {
      connected: Boolean(this.accessToken && Date.now() < this.expiresAt - TOKEN_SKEW_MS),
      expiresAt: this.expiresAt || null,
      error: this.lastError
    };
  }

  async connect(): Promise<string> {
    debugLog('connect:start', {
      host: describeWindow(this.oauthHost),
      page: describeWindow(window)
    });
    void logEnvironmentDiagnostics('connect', this.oauthHost);
    await assertOAuthPopupAllowed(this.oauthHost);
    return this.requestToken('consent');
  }

  async preload(): Promise<void> {
    debugLog('preload:start', {
      host: describeWindow(this.oauthHost),
      page: describeWindow(window)
    });
    void logEnvironmentDiagnostics('preload', this.oauthHost);
    await loadGoogleIdentityScript(this.oauthHost);
    try {
      this.getReadyTokenClient();
    } catch (error) {
      debugWarn('preload:tokenClientSkipped', errorToLog(error));
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }
    const refreshed = await this.refreshAccessToken();
    if (!refreshed) {
      throw new Error('Google Drive 尚未連線或 token 已過期');
    }
    return refreshed;
  }

  async refreshAccessToken(): Promise<string | null> {
    try {
      return await this.requestToken('');
    } catch {
      this.accessToken = null;
      this.expiresAt = 0;
      return null;
    }
  }

  private async requestToken(prompt: 'consent' | ''): Promise<string> {
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    this.pendingRequest = new Promise<string>((resolve, reject) => {
      debugLog('requestToken:start', {
        prompt,
        host: describeWindow(this.oauthHost),
        page: describeWindow(window)
      });
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let popupClosedId: ReturnType<typeof setTimeout> | null = null;
      const finish = (callback: () => void) => {
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
      } catch (error) {
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
    } finally {
      if (this.pendingRequest === request) {
        this.pendingRequest = null;
      }
    }
  }

  private resolveTokenResponse: (response: TokenResponse) => void = () => undefined;
  private resolveTokenError: (error: TokenError) => void = () => undefined;

  private async ensureTokenClient(): Promise<TokenClient> {
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
    const googleApi = (this.oauthHost as GoogleIdentityHost).google?.accounts?.oauth2;
    if (!googleApi?.initTokenClient) {
      debugWarn('tokenClient:init:missingGoogleApi', {
        hasGoogle: Boolean((this.oauthHost as GoogleIdentityHost).google),
        host: describeWindow(this.oauthHost)
      });
      throw new Error('Google Identity Services 載入失敗');
    }
    return this.createTokenClient(clientId, googleApi);
  }

  private getReadyTokenClient(): TokenClient | null {
    const clientId = this.getClientId().trim();
    if (this.tokenClient && this.tokenClientClientId === clientId) {
      debugLog('tokenClient:reuse', { clientId: maskClientId(clientId) });
      return this.tokenClient;
    }
    if (!clientId) {
      throw new Error('請先填入 Google OAuth Client ID');
    }
    const googleApi = (this.oauthHost as GoogleIdentityHost).google?.accounts?.oauth2;
    if (!googleApi?.initTokenClient) {
      return null;
    }
    return this.createTokenClient(clientId, googleApi);
  }

  private createTokenClient(
    clientId: string,
    googleApi: NonNullable<NonNullable<NonNullable<GoogleIdentityHost['google']>['accounts']>['oauth2']>
  ): TokenClient {
    const initTokenClient = googleApi.initTokenClient;
    if (!initTokenClient) {
      throw new Error('Google Identity Services 載入失敗');
    }
    this.tokenClient = initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response: TokenResponse) => this.resolveTokenResponse(response),
      error_callback: (error: TokenError) => this.resolveTokenError(error)
    });
    this.tokenClientClientId = clientId;
    debugLog('tokenClient:init:done', {
      clientId: maskClientId(clientId),
      scope: DRIVE_FILE_SCOPE
    });
    return this.tokenClient as TokenClient;
  }
}

function tokenErrorMessage(error: TokenError): string {
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

let scriptPromise: Promise<void> | null = null;

function loadGoogleIdentityScript(hostWindow: Window): Promise<void> {
  if ((hostWindow as GoogleIdentityHost).google?.accounts?.oauth2) {
    debugLog('gisScript:alreadyLoaded', { host: describeWindow(hostWindow) });
    return Promise.resolve();
  }
  if (scriptPromise) {
    debugLog('gisScript:reusePending', { host: describeWindow(hostWindow) });
    return scriptPromise;
  }
  scriptPromise = new Promise<void>((resolve, reject) => {
    const hostDocument = hostWindow.document;
    const existing = hostDocument.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_URL}"]`);
    if (existing) {
      debugLog('gisScript:existingTag', { host: describeWindow(hostWindow), readyState: existing.dataset.trReady ?? null });
      existing.addEventListener(
        'load',
        () => {
          debugLog('gisScript:existingLoaded', { host: describeWindow(hostWindow) });
          resolve();
        },
        { once: true }
      );
      existing.addEventListener(
        'error',
        () => {
          debugWarn('gisScript:existingError', { host: describeWindow(hostWindow) });
          reject(new Error('Google Identity Services 載入失敗'));
        },
        { once: true }
      );
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

function getOAuthHostWindow(): Window {
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
  } catch {
    debugWarn('oauthHost:crossOriginFallback', { page: describeWindow(window) });
    return window;
  }
  debugLog('oauthHost:selectedSelf', { origin: window.location.origin });
  return window;
}

function debugLog(event: string, details?: unknown): void {
  console.info(formatDebugMessage(event, details));
}

function debugWarn(event: string, details?: unknown): void {
  console.warn(formatDebugMessage(event, details));
}

function formatDebugMessage(event: string, details?: unknown): string {
  const detailsText = stringifyDebugDetails(details);
  return `[TavernRoamer OAuth] ${event}${detailsText ? ` ${detailsText}` : ''}`;
}

function stringifyDebugDetails(details?: unknown): string {
  if (details === undefined || details === null || details === '') {
    return '';
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function describeWindow(targetWindow: Window): Record<string, unknown> {
  try {
    return {
      origin: targetWindow.location.origin,
      href: targetWindow.location.href,
      isSelf: targetWindow === window,
      isParent: targetWindow === window.parent,
      isTop: targetWindow === window.top,
      readyState: targetWindow.document.readyState
    };
  } catch (error) {
    return {
      inaccessible: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function maskClientId(clientId: string): string {
  if (clientId.length <= 18) {
    return clientId;
  }
  return `${clientId.slice(0, 12)}...${clientId.slice(-18)}`;
}

function errorToLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  if (error && typeof error === 'object') {
    return Object.fromEntries(
      Object.entries(error).map(([key, value]) => [key, typeof value === 'function' ? '[function]' : value])
    );
  }
  return { value: String(error) };
}

async function logEnvironmentDiagnostics(phase: string, hostWindow: Window): Promise<void> {
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
  } catch (error) {
    debugWarn(`env:${phase}:headersFailed`, errorToLog(error));
  }
}

async function assertOAuthPopupAllowed(hostWindow: Window): Promise<void> {
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
      throw new Error(
        'SillyTavern 目前送出 Cross-Origin-Opener-Policy: same-origin，Google OAuth popup 無法回傳授權結果。請將 server header 改成 same-origin-allow-popups 或移除該 header，重啟 SillyTavern 後再試。'
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cross-Origin-Opener-Policy: same-origin')) {
      throw error;
    }
    debugWarn('env:oauthCompatibilitySkipped', errorToLog(error));
  }
}

function fetchHostHead(hostWindow: Window): Promise<Response> {
  return hostWindow.fetch(hostWindow.location.href, {
    method: 'HEAD',
    credentials: 'same-origin',
    cache: 'no-store'
  });
}

function getWindowDiagnostics(targetWindow: Window): Record<string, unknown> {
  try {
    return {
      ...describeWindow(targetWindow),
      isSecureContext: targetWindow.isSecureContext,
      crossOriginIsolated: targetWindow.crossOriginIsolated,
      hasOpener: Boolean(targetWindow.opener),
      cookieEnabled: targetWindow.navigator.cookieEnabled,
      userAgent: targetWindow.navigator.userAgent
    };
  } catch (error) {
    return {
      inaccessible: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function getFrameDiagnostics(targetWindow: Window): Record<string, unknown> {
  try {
    const frameElement = targetWindow.frameElement as HTMLIFrameElement | null;
    return {
      hasFrameElement: Boolean(frameElement),
      sandbox: frameElement?.getAttribute('sandbox') ?? null,
      allow: frameElement?.getAttribute('allow') ?? null,
      src: frameElement?.getAttribute('src') ?? null
    };
  } catch (error) {
    return {
      inaccessible: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export { DRIVE_FILE_SCOPE };

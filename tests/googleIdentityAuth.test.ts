import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleIdentityAuth } from '../src/auth/GoogleIdentityAuth';

describe('GoogleIdentityAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('can retry after the first connection attempt fails because the Client ID is empty', async () => {
    let clientId = '';
    const initTokenClient = vi.fn((config: { callback: (response: { access_token: string }) => void }) => ({
      requestAccessToken: () => config.callback({ access_token: 'token' })
    }));
    const hostWindow = createHostWindow(initTokenClient);
    vi.stubGlobal('window', hostWindow);
    vi.stubGlobal('document', hostWindow.document);

    const auth = new GoogleIdentityAuth(() => clientId);
    await expect(auth.connect()).rejects.toThrow('請先填入 Google OAuth Client ID');

    clientId = 'updated-client-id.apps.googleusercontent.com';
    await expect(auth.connect()).resolves.toBe('token');
    expect(initTokenClient).toHaveBeenCalledTimes(1);
  });
});

function createHostWindow(initTokenClient: ReturnType<typeof vi.fn>): Window {
  const host = {
    location: { origin: 'http://localhost:8000', href: 'http://localhost:8000/' },
    document: { readyState: 'complete' },
    navigator: { cookieEnabled: true, userAgent: 'vitest' },
    isSecureContext: false,
    crossOriginIsolated: false,
    opener: null,
    frameElement: null,
    google: { accounts: { oauth2: { initTokenClient } } },
    fetch: vi.fn(async () => new Response(null, { status: 200 }))
  } as unknown as Window & { parent: Window; top: Window };
  host.parent = host;
  host.top = host;
  return host;
}

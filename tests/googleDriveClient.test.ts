import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../src/drive/GoogleDriveClient';

describe('GoogleDriveClient', () => {
  it('uses multipart upload for small JSON and resumable upload for >5MB', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url);
      calls.push(init ? { url: normalizedUrl, init } : { url: normalizedUrl });
      if (normalizedUrl.includes('uploadType=resumable')) {
        return new Response(null, { status: 200, headers: { Location: 'https://upload.example/session' } });
      }
      if (normalizedUrl === 'https://upload.example/session') {
        return Response.json({ id: 'large', name: 'large.json', parents: ['folder'] });
      }
      return Response.json({ id: 'small', name: 'small.json', parents: ['folder'] });
    });
    const client = new GoogleDriveClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokenProvider: {
        getAccessToken: async () => 'token',
        refreshAccessToken: async () => 'token'
      },
      retry: { sleep: async () => undefined }
    });

    const small = await client.uploadJson('folder', 'small.json', { ok: true });
    const large = await client.uploadJson('folder', 'large.json', 'x'.repeat(5 * 1024 * 1024 + 1));

    expect(small.uploadKind).toBe('multipart');
    expect(large.uploadKind).toBe('resumable');
    expect(calls.some(call => call.url.includes('uploadType=multipart'))).toBe(true);
    expect(calls.some(call => call.url.includes('uploadType=resumable'))).toBe(true);
  });

  it('queries folders by name and parent', async () => {
    let requestedUrl = '';
    const client = new GoogleDriveClient({
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return Response.json({ files: [] });
      }) as typeof fetch,
      tokenProvider: {
        getAccessToken: async () => 'token',
        refreshAccessToken: async () => 'token'
      },
      retry: { sleep: async () => undefined }
    });

    await client.findFoldersByName("A'B", 'parent');

    const query = new URL(requestedUrl).searchParams.get('q') ?? '';
    expect(query).toContain("name = 'A\\'B'");
    expect(query).toContain("'parent' in parents");
  });
});

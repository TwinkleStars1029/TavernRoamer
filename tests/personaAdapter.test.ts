import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernServices } from '../src/tavern';
import { parseEnvironmentSnapshot } from '../src/environment/validation';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='), c => c.charCodeAt(0));

describe('Tavern persona adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('embeds avatar bytes so a JSON backup restores on a host without the original image', async () => {
    const persona = { avatar_id: '1784438999373-.png', avatar: '1784438999373-.png', name: 'Traveler', description: 'Story' };
    vi.stubGlobal('getPersona', () => persona);
    vi.stubGlobal('getPersonaAvatarPath', () => './User Avatars/1784438999373-.png');
    const fetchImage = vi.fn(async () => new Response(new Blob([png], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetchImage);

    const snapshot = await createTavernServices().environment.exportPersona();
    expect(fetchImage).toHaveBeenCalledWith('./User Avatars/1784438999373-.png');
    const downloaded = parseEnvironmentSnapshot('persona', JSON.parse(JSON.stringify(snapshot)));
    const createOrReplacePersona = vi.fn(async (_name: string, _data: Record<string, unknown>) => true);
    vi.stubGlobal('createOrReplacePersona', createOrReplacePersona);

    await createTavernServices().environment.applyPersona(downloaded);

    expect(createOrReplacePersona).toHaveBeenCalledOnce();
    const [name, restored] = createOrReplacePersona.mock.calls[0]!;
    expect(name).toBe('Traveler');
    expect(restored.description).toBe('Story');
    expect(restored.avatar).toBeInstanceOf(Blob);
    expect((restored.avatar as Blob).type).toBe('image/png');
    expect(new Uint8Array(await (restored.avatar as Blob).arrayBuffer())).toEqual(png);
    expect(persona.avatar).toBe('1784438999373-.png');
  });

  it('rejects a missing source image rather than uploading an unusable backup', async () => {
    vi.stubGlobal('getPersona', () => ({ name: 'Traveler', avatar: 'missing.png' }));
    vi.stubGlobal('getPersonaAvatarPath', () => './User Avatars/missing.png');
    vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));

    await expect(createTavernServices().environment.exportPersona()).rejects.toThrow('HTTP 404');
  });

  it('keeps existing filename-only backups restorable when the avatar still exists', async () => {
    const createOrReplacePersona = vi.fn(async (_name: string, _data: Record<string, unknown>) => true);
    vi.stubGlobal('createOrReplacePersona', createOrReplacePersona);

    await createTavernServices().environment.applyPersona({
      kind: 'persona', exportedAt: '2026-09-26T00:00:00.000Z', name: 'Traveler',
      data: { name: 'Traveler', avatar: 'existing.png' }
    });

    expect(createOrReplacePersona).toHaveBeenCalledWith('Traveler', { name: 'Traveler', avatar: 'existing.png' });
  });
});

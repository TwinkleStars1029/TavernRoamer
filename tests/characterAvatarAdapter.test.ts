import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernServices } from '../src/tavern';
import { parseEnvironmentSnapshot } from '../src/environment/validation';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='), c => c.charCodeAt(0));

describe('Tavern character avatar adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('backs up image bytes and restores them without the original avatar file', async () => {
    const character = { avatar: 'Storyteller.png', description: 'Keep this description', first_messages: ['Hello'] };
    vi.stubGlobal('getCharacter', async () => character);
    vi.stubGlobal('getCurrentCharacterName', () => 'Storyteller');
    vi.stubGlobal('getCharAvatarPath', () => '/characters/Storyteller.png');
    const fetchImage = vi.fn(async () => new Response(new Blob([png], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetchImage);

    const snapshot = await createTavernServices().environment.exportCharacter();
    expect(fetchImage).toHaveBeenCalledWith('/characters/Storyteller.png');
    const downloaded = parseEnvironmentSnapshot('character', JSON.parse(JSON.stringify(snapshot)));
    const createOrReplaceCharacter = vi.fn(async (_name: string, _data: Record<string, unknown>, _options: unknown) => true);
    vi.stubGlobal('createOrReplaceCharacter', createOrReplaceCharacter);

    await createTavernServices().environment.applyCharacter(downloaded);

    expect(createOrReplaceCharacter).toHaveBeenCalledOnce();
    const [name, restored, options] = createOrReplaceCharacter.mock.calls[0]!;
    expect(name).toBe('Storyteller');
    expect(options).toEqual({ render: 'none' });
    expect(restored.description).toBe('Keep this description');
    expect(restored.first_messages).toEqual(['Hello']);
    expect(restored.avatar).toBeInstanceOf(Blob);
    expect((restored.avatar as Blob).type).toBe('image/png');
    expect(new Uint8Array(await (restored.avatar as Blob).arrayBuffer())).toEqual(png);
    expect(character.avatar).toBe('Storyteller.png');
  });

  it('stops backup if the source avatar cannot be fetched', async () => {
    vi.stubGlobal('getCharacter', async () => ({ avatar: 'missing.png', description: 'Story' }));
    vi.stubGlobal('getCurrentCharacterName', () => 'Storyteller');
    vi.stubGlobal('getCharAvatarPath', () => '/characters/missing.png');
    vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));

    await expect(createTavernServices().environment.exportCharacter()).rejects.toThrow('HTTP 404');
  });

  it('still accepts older character backups without embedded images', async () => {
    const createOrReplaceCharacter = vi.fn(async (_name: string, _data: Record<string, unknown>, _options: unknown) => true);
    vi.stubGlobal('createOrReplaceCharacter', createOrReplaceCharacter);

    await createTavernServices().environment.applyCharacter({
      kind: 'character', exportedAt: '2026-09-27T00:00:00.000Z', characterName: 'Storyteller',
      data: { avatar: 'Storyteller.png', description: 'Story' }
    });

    expect(createOrReplaceCharacter).toHaveBeenCalledWith(
      'Storyteller', { avatar: 'Storyteller.png', description: 'Story' }, { render: 'none' }
    );
  });
});

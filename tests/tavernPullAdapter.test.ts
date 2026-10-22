import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPulledChatFileName, deriveChatId } from '../src/chat/meta';
import { createTavernPullAdapter } from '../src/tavern';

describe('pulled chat filename round-trip', () => {
  it('derives the same chat_id from the pulled filename (identity continuity)', () => {
    const chatId = '2026-06-28@15h24m22s470ms';
    expect(deriveChatId(buildPulledChatFileName('Alice', chatId))).toBe(chatId);
    expect(deriveChatId(`${buildPulledChatFileName('Alice', chatId)}.jsonl`)).toBe(chatId);
  });

  it('keeps non-timestamp chat ids underivable so existing meta wins', () => {
    // fallback 型 chat_id（如 chat_123）derive 不出時間戳 → ensureSyncMeta 不會重綁
    expect(deriveChatId(buildPulledChatFileName('Alice', 'chat_1234567890'))).toBeNull();
  });
});

describe('createTavernPullAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists character names and selects character by name', async () => {
    const selectCharacterById = vi.fn();
    stubTavernContext({
      characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' }],
      selectCharacterById
    });
    const adapter = createTavernPullAdapter();
    expect(adapter.listCharacterNames()).toEqual(['Alice', 'Bob']);
    await adapter.selectCharacterByName('Bob');
    expect(selectCharacterById).toHaveBeenCalledWith(1);
  });

  it('throws when selecting a character that does not exist locally', async () => {
    stubTavernContext({ characters: [{ name: 'Alice', avatar: 'alice.png' }], selectCharacterById: vi.fn() });
    const adapter = createTavernPullAdapter();
    await expect(adapter.selectCharacterByName('Nobody')).rejects.toThrow('找不到角色卡');
  });

  it('lists current character chat files via /api/characters/chats', async () => {
    stubTavernContext({
      characters: [{ name: 'Alice', avatar: 'alice.png' }],
      characterId: '0'
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ file_name: 'Alice - 2026-06-28@15h24m22s470ms.jsonl' }]), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createTavernPullAdapter();
    const files = await adapter.listCurrentCharacterChatFiles();
    expect(fetchMock).toHaveBeenCalledWith('/api/characters/chats', expect.objectContaining({ method: 'POST' }));
    expect(files).toEqual(['Alice - 2026-06-28@15h24m22s470ms.jsonl']);
  });

  it('creates chat file via /api/chats/save then opens it', async () => {
    const openCharacterChat = vi.fn();
    stubTavernContext({
      characters: [{ name: 'Alice', avatar: 'alice.png' }],
      characterId: '0',
      openCharacterChat
    });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createTavernPullAdapter();
    const rawJsonl = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hi' })}`;
    await adapter.createAndOpenChatFile('Alice - 2026-06-28@15h24m22s470ms', rawJsonl);

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/save', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.file_name).toBe('Alice - 2026-06-28@15h24m22s470ms');
    expect(body.force).toBe(true);
    expect(Array.isArray(body.chat)).toBe(true);
    expect(openCharacterChat).toHaveBeenCalledWith('Alice - 2026-06-28@15h24m22s470ms');
  });

  it('saves to the explicitly supplied character even when another character is current', async () => {
    stubTavernContext({
      characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' }],
      characterId: '0'
    });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createTavernPullAdapter();
    const rawJsonl = `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hi' })}`;

    await adapter.createChatFile({ name: 'Bob', avatarUrl: 'bob.png' }, 'Bob - fixed', rawJsonl);

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.avatar_url).toBe('bob.png');
    expect(body.file_name).toBe('Bob - fixed');
  });

  it('refuses to create a chat file when openCharacterChat is unavailable (probe before mutation)', async () => {
    stubTavernContext({ characters: [{ name: 'Alice', avatar: 'alice.png' }], characterId: '0' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createTavernPullAdapter();
    await expect(adapter.createAndOpenChatFile('x', '{}')).rejects.toThrow('openCharacterChat');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stubTavernContext(context: Record<string, unknown>) {
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), ...context })
  });
}

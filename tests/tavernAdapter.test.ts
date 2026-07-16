import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernApi } from '../src/tavern';

describe('Tavern chat adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores swiped packages with the active swipe as message text', async () => {
    const created: Record<string, unknown>[][] = [];
    const restored: Record<string, unknown>[][] = [];
    vi.stubGlobal('getVariables', () => ({}));
    vi.stubGlobal('getLastMessageId', () => 0);
    vi.stubGlobal('deleteChatMessages', vi.fn());
    vi.stubGlobal('createChatMessages', vi.fn((messages: Record<string, unknown>[]) => {
      created.push(messages);
    }));
    vi.stubGlobal('setChatMessages', vi.fn((messages: Record<string, unknown>[]) => {
      restored.push(messages);
    }));

    const adapter = createTavernApi().getChatAdapter();
    await adapter.replaceChat({
      format_version: 1,
      metadata: {
        chat_id: 'chat_1',
        role_key: 'role',
        device: 'device',
        message_count: 1,
        packed_at: '2026-06-25T14:45:00.000Z'
      },
      chat_variables: {},
      chat_worldbook: null,
      messages: [
        {
          message_id: 0,
          name: 'Assistant',
          role: 'assistant',
          is_hidden: false,
          swipe_id: 1,
          swipes: ['first draft', 'chosen draft'],
          swipes_data: [{ draft: 1 }, { draft: 2 }],
          swipes_info: [{ model: 'a' }, { model: 'b' }]
        }
      ]
    });

    expect(created[0]?.[0]).toMatchObject({
      name: 'Assistant',
      role: 'assistant',
      is_hidden: false,
      message: 'chosen draft',
      data: { draft: 2 },
      extra: { model: 'b' }
    });
    expect(restored[0]?.[0]).toMatchObject({
      message_id: 0,
      message: 'chosen draft',
      swipes: ['first draft', 'chosen draft'],
      swipes_data: [{ draft: 1 }, { draft: 2 }],
      swipes_info: [{ model: 'a' }, { model: 'b' }]
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernApi } from '../src/tavern';

describe('Tavern chat adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports the explicitly captured chat instead of the chat currently shown later', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
      result: `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hello' })}`
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const adapter = createTavernApi().getChatAdapter();

    await adapter.exportRawChat({
      nativeChatId: 'Chat A',
      rawFileName: 'Chat A.jsonl',
      displayFileName: 'Role - 2026-06-28@15h24m22s470ms.json',
      avatarUrl: 'role-a.png'
    });

    const request = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      file: 'Chat A.jsonl',
      exportfilename: 'Chat A.jsonl',
      avatar_url: 'role-a.png'
    });
  });

  it('saves to the captured chat and does not reload another chat that is currently shown', async () => {
    const reloadCurrentChat = vi.fn();
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        getCurrentChatId: () => 'Chat B',
        chatFileName: 'Chat B.jsonl',
        characterId: '0',
        characters: [{ avatar: 'role-b.png' }],
        reloadCurrentChat
      })
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const adapter = createTavernApi().getChatAdapter();

    await adapter.replaceRawChat(
      `${JSON.stringify({ user_name: 'User', chat_metadata: {} })}\n${JSON.stringify({ mes: 'hello' })}`,
      {
        nativeChatId: 'Chat A',
        rawFileName: 'Chat A.jsonl',
        displayFileName: 'Chat A.jsonl',
        avatarUrl: 'role-a.png'
      }
    );

    const request = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ file_name: 'Chat A', avatar_url: 'role-a.png' });
    expect(reloadCurrentChat).not.toHaveBeenCalled();
  });

  it('preserves MVU variables for every swipe when exporting and restoring raw chat', async () => {
    const rows = [
      { user_name: 'Traveler', chat_metadata: { variables: { story_stage: 3 } } },
      {
        name: 'Narrator', mes: 'Second swipe', swipe_id: 1,
        swipes: ['First swipe', 'Second swipe'],
        variables: [
          { stat_data: { hp: 10, inventory: ['key'] } },
          { stat_data: { hp: 8, inventory: ['key', 'map'] } }
        ]
      }
    ];
    const raw = rows.map(row => JSON.stringify(row)).join('\n');
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return url.endsWith('/export') ? Response.json({ result: raw }) : new Response(null, { status: 200 });
    }));
    const adapter = createTavernApi().getChatAdapter();
    const ref = {
      nativeChatId: 'mvu-chat', rawFileName: 'mvu-chat.jsonl',
      displayFileName: 'mvu-chat.jsonl', avatarUrl: 'role.png'
    };

    const exported = await adapter.exportRawChat(ref);
    expect(exported.content).toBe(raw);
    await adapter.replaceRawChat(exported.content, ref);

    expect(requests[1]?.body.chat).toEqual(rows);
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

  it('creates a missing worldbook while restoring a cloud snapshot', async () => {
    const createOrReplaceWorldbook = vi.fn();
    const replaceWorldbook = vi.fn(() => {
      throw new Error('replaceWorldbook must not be used when upsert is available');
    });
    vi.stubGlobal('createOrReplaceWorldbook', createOrReplaceWorldbook);
    vi.stubGlobal('replaceWorldbook', replaceWorldbook);

    const adapter = createTavernApi().getChatAdapter();
    const entries = [{ uid: 1, name: 'entry', content: 'content' }];
    await adapter.applyWorld({
      kind: 'world',
      exportedAt: '2026-07-21T00:00:00.000Z',
      bindings: {
        chat: null,
        char_primary: null,
        char_additional: [],
        global_enabled: []
      },
      books: {
        sasuke_data_總lorebook: entries
      }
    });

    expect(createOrReplaceWorldbook).toHaveBeenCalledWith('sasuke_data_總lorebook', entries);
    expect(replaceWorldbook).not.toHaveBeenCalled();
  });

  it('exports the exact stored OpenAI preset without Tavern Helper normalization', async () => {
    const preset = {
      temp_openai: 1,
      openai_max_context: 200000,
      prompts: Array.from({ length: 242 }, (_value, index) => ({
        identifier: `prompt-${index}`,
        name: `Prompt ${index}`,
        enabled: index % 2 === 0,
        role: 'system',
        content: `Content ${index}`,
        injection_trigger: [],
        injection_depth: 4,
        marker: false,
        system_prompt: false
      })),
      prompt_order: [{ character_id: 100001, order: Array.from({ length: 164 }, (_value, index) => ({ identifier: `prompt-${index}`, enabled: true })) }],
      extensions: {
        regex_scripts: Array.from({ length: 21 }, (_value, index) => ({
          id: `regex-${index}`,
          scriptName: `Regex ${index}`,
          findRegex: '/foo/g',
          replaceString: 'bar'
        })),
        tavern_helper: {
          scripts: [{ id: 'script-1', name: 'Preset script', content: 'console.log(1)' }],
          variables: { route: 'cloud' }
        }
      },
      assistant_prefill: '',
      claude_use_sysprompt: false
    };
    const manager = {
      getSelectedPresetName: () => '【MoM】果实C0.3',
      getCompletionPresetByName: vi.fn(() => preset)
    };
    vi.stubGlobal('SillyTavern', { getContext: () => ({ getPresetManager: () => manager }) });

    const snapshot = await createTavernApi().getChatAdapter().exportPreset();

    expect(snapshot).toMatchObject({
      kind: 'preset',
      name: '【MoM】果实C0.3',
      format: 'sillytavern-openai-preset-v1'
    });
    expect(snapshot.data).toEqual(preset);
    expect(snapshot.data).not.toBe(preset);
    expect((snapshot.data as typeof preset).prompts).toHaveLength(242);
    expect((snapshot.data as typeof preset).prompt_order[0]?.order).toHaveLength(164);
    expect((snapshot.data as typeof preset).extensions.regex_scripts).toHaveLength(21);
    expect((snapshot.data as typeof preset).extensions.tavern_helper.scripts).toHaveLength(1);
    expect((snapshot.data as typeof preset).extensions.tavern_helper.variables).toEqual({ route: 'cloud' });
    expect((snapshot.data as typeof preset).assistant_prefill).toBe('');
    expect((snapshot.data as typeof preset).claude_use_sysprompt).toBe(false);
  });

  it('restores an exact raw OpenAI preset through the OpenAI preset manager', async () => {
    const data = {
      temp_openai: 0.8,
      prompts: [{ identifier: 'main', enabled: true, role: 'system', content: 'Stay in character', injection_trigger: [] }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
      extensions: { regex_scripts: [], tavern_helper: { scripts: [], variables: { state: 1 } } },
      assistant_prefill: ''
    };
    const savePreset = vi.fn();
    const selectPreset = vi.fn();
    const manager = { savePreset, findPreset: () => 'openai-option', selectPreset };
    const getPresetManager = vi.fn((apiId: string) => apiId === 'openai' ? manager : null);
    vi.stubGlobal('SillyTavern', { getContext: () => ({ getPresetManager }) });

    await createTavernApi().getChatAdapter().applyPreset({
      kind: 'preset',
      exportedAt: '2026-08-13T00:00:00.000Z',
      name: 'Complete Preset',
      format: 'sillytavern-openai-preset-v1',
      data
    });

    expect(savePreset).toHaveBeenCalledWith('Complete Preset', data, { skipUpdate: false });
    expect(savePreset.mock.calls[0]?.[1]).not.toBe(data);
    expect(selectPreset).toHaveBeenCalledWith('openai-option');
    expect(getPresetManager).toHaveBeenCalledWith('openai');
  });

  it('keeps Tavern Helper preset restore compatibility for existing backups', async () => {
    const data = {
      settings: { temperature: 0.8 },
      prompts: [{ id: 'main', enabled: true, role: 'system', content: 'Stay in character' }],
      prompts_unused: [],
      extensions: {}
    };
    const createOrReplacePreset = vi.fn();
    const loadPreset = vi.fn(() => true);
    vi.stubGlobal('createOrReplacePreset', createOrReplacePreset);
    vi.stubGlobal('loadPreset', loadPreset);

    await createTavernApi().getChatAdapter().applyPreset({
      kind: 'preset',
      exportedAt: '2026-08-13T00:00:00.000Z',
      name: 'Normalized Preset',
      format: 'tavern-helper-preset-v1',
      data
    });

    expect(createOrReplacePreset).toHaveBeenCalledWith('Normalized Preset', data, { render: 'immediate' });
    expect(loadPreset).toHaveBeenCalledWith('Normalized Preset');
  });

  it('keeps the legacy text-generation restore path for existing cloud backups', async () => {
    const savePreset = vi.fn();
    const selectPreset = vi.fn();
    const manager = {
      savePreset,
      findPreset: () => 'legacy-option',
      selectPreset
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ getPresetManager: (apiId: string) => apiId === 'textgenerationwebui' ? manager : null })
    });

    await createTavernApi().getChatAdapter().applyPreset({
      kind: 'preset',
      exportedAt: '2026-07-01T00:00:00.000Z',
      name: 'Legacy Preset',
      data: { temp: 1, top_k: 40 }
    });

    expect(savePreset).toHaveBeenCalledWith('Legacy Preset', { temp: 1, top_k: 40 }, { skipUpdate: false });
    expect(selectPreset).toHaveBeenCalledWith('legacy-option');
  });
});

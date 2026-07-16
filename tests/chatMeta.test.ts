import { describe, expect, it } from 'vitest';
import { ensureSyncMeta } from '../src/chat/meta';
import { CHAT_META_KEY } from '../src/types';

describe('ensureSyncMeta', () => {
  it('creates chat_id from the current chat file name when missing', () => {
    const variables: Record<string, unknown> = {};
    const meta = ensureSyncMeta(
      {
        getChatVariables: () => variables,
        writeChatVariables: value => Object.assign(variables, value),
        getCurrentCharacterName: () => 'Route/Lute',
        getCurrentChatFileName: () => 'Route - 2026-06-28@15h24m22s470ms.json'
      },
      'DeviceA'
    );

    expect(meta.chat_id).toBe('2026-06-28@15h24m22s470ms');
    expect(meta.role_key).toBe('Route Lute');
    expect(variables[CHAT_META_KEY]).toEqual(meta);
  });

  it('rebinds existing meta to the current file-derived chat id', () => {
    const existing = { chat_id: 'chat_existing', role_key: 'Route' };
    const variables: Record<string, unknown> = { [CHAT_META_KEY]: existing };

    const meta = ensureSyncMeta(
      {
        getChatVariables: () => variables,
        writeChatVariables: value => Object.assign(variables, value),
        getCurrentCharacterName: () => 'Changed Name',
        getCurrentChatFileName: () => 'Route - 2026-06-28@15h24m22s470ms.json'
      },
      'DeviceA'
    );

    expect(meta.chat_id).toBe('2026-06-28@15h24m22s470ms');
    expect(meta.role_key).toBe('Route');
    expect(variables[CHAT_META_KEY]).toEqual(meta);
  });
});

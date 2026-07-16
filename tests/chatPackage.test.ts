import { describe, expect, it } from 'vitest';
import { createChatPackage, unpackChatPackage } from '../src/chat/package';

describe('chat package', () => {
  it('roundtrips through JSON', () => {
    const packed = createChatPackage({
      meta: { chat_id: 'chat_1', role_key: '路特' },
      deviceName: 'A電腦',
      messages: [{ message_id: 0, role: 'user', message: 'hi', swipes: ['hi'] }],
      chatVariables: { foo: 'bar' },
      chatWorldbook: '路特世界書',
      packedAt: new Date('2026-06-25T14:45:00Z')
    });

    expect(unpackChatPackage(JSON.stringify(packed))).toEqual(packed);
  });

  it('rejects unsupported format version and broken JSON', () => {
    expect(() => unpackChatPackage('{')).toThrow('JSON 損壞');
    expect(() => unpackChatPackage({ format_version: 999 })).toThrow('不支援');
  });
});

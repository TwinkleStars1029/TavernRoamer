import { describe, expect, it } from 'vitest';
import { createChatContentSnapshot, parseRawChatContent } from '../src/chat/snapshot';

function jsonl(header: Record<string, unknown>, message: Record<string, unknown>): string {
  return `${JSON.stringify(header)}\n${JSON.stringify(message)}`;
}

describe('chat content snapshots', () => {
  it('ignores JSON key order and known sync bookkeeping locations', async () => {
    const left = jsonl(
      { user_name: 'U', chat_metadata: { variables: { _drive_sync: { last: 1 }, keep: true } } },
      { mes: 'hello', extra: { b: 2, a: 1 } }
    );
    const right = jsonl(
      { chat_metadata: { variables: { keep: true, _drive_sync: { last: 2 } } }, user_name: 'U' },
      { extra: { a: 1, b: 2 }, mes: 'hello' }
    );

    expect((await createChatContentSnapshot(left)).contentHash).toBe((await createChatContentSnapshot(right)).contentHash);
  });

  it('detects equal-length edits, swipe changes and unknown extension changes', async () => {
    const base = jsonl({ user_name: 'U', chat_metadata: {} }, {
      mes: 'cat', swipes: ['cat', 'dog'], swipe_id: 0, extensions: { custom: 1 }
    });
    const edit = jsonl({ user_name: 'U', chat_metadata: {} }, {
      mes: 'dog', swipes: ['cat', 'dog'], swipe_id: 1, extensions: { custom: 2 }
    });

    expect((await createChatContentSnapshot(base)).messageCount).toBe(1);
    expect((await createChatContentSnapshot(base)).contentHash).not.toBe((await createChatContentSnapshot(edit)).contentHash);
  });

  it('rejects truncated, scalar and headerless JSONL', () => {
    expect(() => parseRawChatContent('{"user_name":"U"}\n{"mes":')).toThrow('第 2 行');
    expect(() => parseRawChatContent('[]')).toThrow('必須是物件');
    expect(() => parseRawChatContent('{"mes":"hello"}')).toThrow('缺少合法 header');
  });
});

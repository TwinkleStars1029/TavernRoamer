import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueUpload,
  getUploadQueueUsage,
  loadUploadQueue,
  UploadQueueCapacityError,
  UploadQueueStorageError
} from '../src/chat/queue';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upload queue capacity', () => {
  it('refuses a new snapshot without dropping existing work when the item limit is reached', () => {
    stubScriptStore();
    enqueueUpload(job('first'), { maxItems: 1, maxBytes: 1024 * 1024 });

    expect(() => enqueueUpload(job('second'), { maxItems: 1, maxBytes: 1024 * 1024 }))
      .toThrow(UploadQueueCapacityError);
    expect(loadUploadQueue().map(item => item.filename)).toEqual(['first.jsonl']);
  });

  it('measures serialized bytes and refuses a snapshot that exceeds the byte limit', () => {
    stubScriptStore();

    expect(() => enqueueUpload(job('large', 'x'.repeat(128)), { maxItems: 100, maxBytes: 64 }))
      .toThrow(UploadQueueCapacityError);
    expect(getUploadQueueUsage()).toEqual({ items: 0, bytes: 2 });
  });

  it('reports persistence failure without claiming the work was queued', () => {
    vi.stubGlobal('getVariables', () => ({}));
    vi.stubGlobal('insertOrAssignVariables', () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(() => enqueueUpload(job('quota')))
      .toThrow(UploadQueueStorageError);
    expect(loadUploadQueue()).toEqual([]);
  });
});

function job(filename: string, content = '{}') {
  return {
    path: ['SillyTavernSync', 'role', 'chat', 'chat'],
    filename: `${filename}.jsonl`,
    package: content,
    mimeType: 'application/x-ndjson'
  };
}

function stubScriptStore(): void {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('getVariables', () => store);
  vi.stubGlobal('insertOrAssignVariables', (value: Record<string, unknown>) => Object.assign(store, value));
}

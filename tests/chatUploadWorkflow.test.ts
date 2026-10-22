import { describe, expect, it, vi } from 'vitest';
import { ChatUploadWorkflow } from '../src/chat/ChatUploadWorkflow';
import type { ChatSyncTarget } from '../src/chat/context';
import type { EnvironmentItemKind } from '../src/environment/types';

describe('ChatUploadWorkflow', () => {
  it('aborts the chat upload when a required first character backup fails', async () => {
    const fixture = makeFixture({ characterBackupFails: true });
    const preparation = await fixture.workflow.prepare();
    const result = await fixture.workflow.execute({
      preparationId: preparation.preparationId,
      selectedEnvironment: ['character', 'world'],
      chatOnly: false
    });

    expect(result.status).toBe('aborted');
    expect(result.recoveryStatus).toBe('missing_character');
    expect(fixture.uploadChat).not.toHaveBeenCalled();
  });

  it('allows an explicit chat-only upload while reporting missing recovery data', async () => {
    const fixture = makeFixture();
    const preparation = await fixture.workflow.prepare();
    const result = await fixture.workflow.execute({
      preparationId: preparation.preparationId,
      selectedEnvironment: [],
      chatOnly: true
    });

    expect(result.status).toBe('done');
    expect(result.recoveryStatus).toBe('missing_character');
    expect(fixture.backupItems).not.toHaveBeenCalled();
    expect(fixture.uploadChat).toHaveBeenCalledTimes(1);
  });

  it('continues uploading the chat when only an optional environment item fails', async () => {
    const fixture = makeFixture({ optionalBackupFails: true });
    const preparation = await fixture.workflow.prepare();
    const result = await fixture.workflow.execute({
      preparationId: preparation.preparationId,
      selectedEnvironment: ['character', 'world'],
      chatOnly: false
    });

    expect(result.status).toBe('partial');
    expect(result.recoveryStatus).toBe('ready');
    expect(fixture.uploadChat).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale preparation before making any writes', async () => {
    const fixture = makeFixture();
    const preparation = await fixture.workflow.prepare();
    fixture.assertCurrent.mockImplementation(() => { throw new Error('聊天已切換'); });

    await expect(fixture.workflow.execute({
      preparationId: preparation.preparationId,
      selectedEnvironment: ['character'],
      chatOnly: false
    })).rejects.toThrow('聊天已切換');
    expect(fixture.backupItems).not.toHaveBeenCalled();
    expect(fixture.uploadChat).not.toHaveBeenCalled();
  });

  it('invalidates prepared uploads when the active chat changes', async () => {
    const fixture = makeFixture();
    const preparation = await fixture.workflow.prepare();
    fixture.workflow.invalidateAll();

    await expect(fixture.workflow.execute({
      preparationId: preparation.preparationId,
      selectedEnvironment: [],
      chatOnly: true
    })).rejects.toThrow('上傳確認已過期');
  });
});

function makeFixture(options: { characterBackupFails?: boolean; optionalBackupFails?: boolean } = {}) {
  const target = makeTarget();
  const captureCurrentChat = vi.fn(() => target);
  const assertCurrent = vi.fn();
  const uploadChat = vi.fn(async () => ({
    operationId: 'upload-1',
    meta: target.meta,
    filename: '2026-10-19T01-00-00Z__device.jsonl',
    path: ['SillyTavernSync', 'Role', 'chat', 'chat'],
    queued: false,
    metadata: 'applied' as const,
    cleanup: 'done' as const
  }));
  const backupItems = vi.fn(async (kinds: readonly EnvironmentItemKind[]) => kinds.map(kind => ({
    kind,
    status: options.characterBackupFails && kind === 'character' || options.optionalBackupFails && kind === 'world'
      ? 'error' as const
      : 'done' as const,
    ...(options.characterBackupFails && kind === 'character' || options.optionalBackupFails && kind === 'world'
      ? { error: 'backup failed' }
      : { filename: `${kind}.json` })
  })));
  const inspect = vi.fn(async () => ({
    target,
    isFirstUpload: true,
    latestChatFilename: null,
    recoveryStatus: 'first_upload' as const,
    environment: (['character', 'world', 'persona', 'preset', 'regex'] as EnvironmentItemKind[]).map(kind => ({
      kind,
      available: false,
      latestFilename: null
    }))
  }));
  const workflow = new ChatUploadWorkflow(
    { captureCurrentChat, assertTargetCurrent: assertCurrent, uploadChat },
    { backupItems },
    { inspect }
  );
  return { workflow, assertCurrent, uploadChat, backupItems };
}

function makeTarget(): ChatSyncTarget {
  return {
    operationId: 'op-1',
    key: 'role/chat',
    contextRevision: 1,
    ref: { nativeChatId: 'chat', rawFileName: 'chat.jsonl', displayFileName: 'chat', avatarUrl: 'role.png' },
    meta: { role_key: 'Role', chat_id: 'chat' }
  };
}

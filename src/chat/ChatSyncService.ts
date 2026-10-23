import { buildVersionFilename } from '../drive/version';
import type { DriveService } from '../drive/DriveService';
import { DriveError } from '../drive/DriveClient';
import { mapWithConcurrency } from '../drive/concurrency';
import { loadSettings } from '../settings';
import type { ChatSyncMeta } from '../types';
import { ChatOperationCoordinator } from './ChatOperationCoordinator';
import { chatRefKey, sameChatRef, type ChatSyncTarget, type TavernChatRef } from './context';
import { ensureSyncMeta, updateLastSyncedVersion } from './meta';
import { createChatPackage, unpackChatPackage, type ChatPackage } from './package';
import type { ChatSyncPort, RawChatFile } from './ports/ChatSyncPort';
import {
  enqueueUpload,
  incrementQueuedUpload,
  loadUploadQueue,
  markQueuedUploadVerified,
  removeQueuedUpload,
  setQueuedUploadRemoteId,
  type QueuedChatUpload
} from './queue';
import { loadSyncReceipts, markSyncReceiptSuperseded, saveSyncReceipt, removeSyncReceipt } from './receipts';
import { loadRetentionQueue, enqueueRetention, removeRetention } from './retentionQueue';
import { createChatContentSnapshot, parseRawChatContent, type ChatContentSnapshot } from './snapshot';
import { getContextRevision } from '../contextRevision';

const RAW_CHAT_MIME = 'application/x-ndjson; charset=UTF-8';

/** @deprecated Import ChatSyncPort from chat/ports/ChatSyncPort. */
export type TavernChatAdapter = ChatSyncPort;
export type { ChatSyncPort, RawChatFile } from './ports/ChatSyncPort';

export type UploadResult = {
  operationId: string;
  meta: ChatSyncMeta;
  filename: string;
  path: string[];
  queued: boolean;
  metadata: 'applied' | 'deferred' | 'failed';
  cleanup: 'done' | 'pending' | 'skipped';
};

export type DownloadResult = {
  filename: string;
  status: 'done' | 'partial';
  metadata: UploadResult['metadata'];
};

export type RemoteVersionState = {
  latestFilename: string | null;
  baselineFound: boolean;
};

export class ChatSyncService {
  private coordinator = new ChatOperationCoordinator();
  private flushPromise: Promise<{ uploaded: number; remaining: number }> | null = null;

  constructor(
    private tavern: ChatSyncPort,
    private drive: DriveService
  ) {}

  ensureSyncMeta(): ChatSyncMeta {
    return ensureSyncMeta(this.tavern, loadSettings().deviceName);
  }

  captureCurrentChat(): ChatSyncTarget {
    const contextRevision = getContextRevision();
    const ref = this.currentChatRef();
    const meta = this.ensureSyncMeta();
    if (!this.isCurrent(ref, contextRevision)) {
      throw new Error('聊天已切換，請在目標聊天重新操作');
    }
    return {
      operationId: createOperationId(),
      key: chatRefKey(ref),
      ref,
      meta,
      contextRevision
    };
  }

  packChat(meta = this.ensureSyncMeta()): ChatPackage {
    const settings = loadSettings();
    return createChatPackage({
      meta,
      deviceName: settings.deviceName,
      messages: this.tavern.getMessages(),
      chatVariables: this.tavern.getChatVariables(),
      chatWorldbook: this.tavern.getChatWorldbook()
    });
  }

  uploadCurrentChat(options: { queueOnFail?: boolean } = {}): Promise<UploadResult> {
    return this.uploadChat(this.captureCurrentChat(), options);
  }

  uploadChat(target: ChatSyncTarget, options: { queueOnFail?: boolean } = {}): Promise<UploadResult> {
    return this.coordinator.run(target.key, () => this.performUpload(target, options));
  }

  assertTargetCurrent(target: ChatSyncTarget): void {
    this.assertCurrent(target.ref, target.contextRevision);
  }

  flushQueue(): Promise<{ uploaded: number; remaining: number }> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    const running = this.performFlushQueue();
    this.flushPromise = running;
    void running.then(() => {
      if (this.flushPromise === running) {
        this.flushPromise = null;
      }
    }, () => {
      if (this.flushPromise === running) {
        this.flushPromise = null;
      }
    });
    return running;
  }

  downloadLatestAndReplace(): Promise<DownloadResult> {
    const target = this.captureCurrentChat();
    return this.coordinator.run(target.key, () => this.performDownloadLatestAndReplace(target));
  }

  async getLatestRemoteFilename(meta = this.ensureSyncMeta()): Promise<string | null> {
    return (await this.getRemoteVersionState(meta)).latestFilename;
  }

  async getRemoteVersionState(meta = this.ensureSyncMeta()): Promise<RemoteVersionState> {
    const versions = (await this.drive.listVersions(driveChatPath(meta)))
      .filter(version => version.filename.endsWith('.jsonl'));
    return {
      latestFilename: versions.at(-1)?.filename ?? null,
      baselineFound: Boolean(
        meta.last_synced_version && versions.some(version => version.filename === meta.last_synced_version)
      )
    };
  }

  async getCurrentContentHash(): Promise<string> {
    const contextRevision = getContextRevision();
    const ref = this.currentChatRef();
    const raw = await this.tavern.exportRawChat(ref);
    this.assertCurrent(ref, contextRevision);
    return (await createChatContentSnapshot(raw.content)).contentHash;
  }

  async applyPendingReceiptsForCurrent(): Promise<number> {
    let applied = 0;
    for (const receipt of loadSyncReceipts()) {
      if (!this.isCurrent(receipt.ref) || receipt.status === 'superseded') {
        continue;
      }
      try {
        const contextRevision = getContextRevision();
        if (!receipt.contentHash || !receipt.hashVersion) {
          markSyncReceiptSuperseded(receipt.id);
          continue;
        }
        const local = await createChatContentSnapshot((await this.tavern.exportRawChat(receipt.ref)).content);
        if (local.contentHash !== receipt.contentHash || local.hashVersion !== receipt.hashVersion) {
          markSyncReceiptSuperseded(receipt.id);
          continue;
        }
        this.assertCurrent(receipt.ref, contextRevision);
        const current = this.ensureSyncMeta();
        if (!current.last_synced_version || current.last_synced_version <= receipt.filename) {
          updateLastSyncedVersion(this.tavern, current, receipt.filename, receipt.messageCount, {
            hash: receipt.contentHash,
            version: receipt.hashVersion
          });
        }
        removeSyncReceipt(receipt.id);
        applied += 1;
      } catch {
        // 保留 receipt，下次切回此聊天或重新載入時再試。
      }
    }
    return applied;
  }

  private async performUpload(
    target: ChatSyncTarget,
    options: { queueOnFail?: boolean }
  ): Promise<UploadResult> {
    const rawChat = await this.tavern.exportRawChat(target.ref);
    const snapshot = await createChatContentSnapshot(rawChat.content);
    const filename = buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl');
    const path = driveChatPath(target.meta);
    const job = enqueueUpload({
      operationId: target.operationId,
      status: 'pending_upload',
      path,
      filename,
      package: rawChat.content,
      mimeType: RAW_CHAT_MIME,
      ref: target.ref,
      meta: target.meta,
      messageCount: snapshot.messageCount,
      contentHash: snapshot.contentHash,
      hashVersion: snapshot.hashVersion
    });
    try {
      const folderId = await this.drive.ensureFolderPath(path);
      const remoteFileId = await this.uploadQueuedPayload(job, folderId);
      markQueuedUploadVerified(job.id, remoteFileId);
    } catch (error) {
      if (!options.queueOnFail) {
        removeQueuedUpload(job.id);
        throw error;
      }
      incrementQueuedUpload(job.id);
      return {
        operationId: target.operationId,
        meta: target.meta,
        filename,
        path,
        queued: true,
        metadata: 'deferred',
        cleanup: 'skipped'
      };
    }

    const metadata = await this.finalizeSync(
      target.operationId,
      target.ref,
      target.meta,
      filename,
      snapshot,
      target.contextRevision
    );
    if (metadata !== 'failed') {
      removeQueuedUpload(job.id);
    }
    const cleanup = await this.cleanupAfterUpload(path);
    return {
      operationId: target.operationId,
      meta: { ...target.meta, last_synced_version: filename },
      filename,
      path,
      queued: false,
      metadata,
      cleanup
    };
  }

  private async performFlushQueue(): Promise<{ uploaded: number; remaining: number }> {
    let uploaded = 0;
    for (const item of loadUploadQueue()) {
      const key = item.ref ? chatRefKey(item.ref) : JSON.stringify(item.path);
      const completed = await this.coordinator.run(key, () => this.flushItem(item));
      if (completed) {
        uploaded += 1;
      }
    }
    await this.retryRetentionQueue();
    return { uploaded, remaining: loadUploadQueue().length };
  }

  private async flushItem(item: QueuedChatUpload): Promise<boolean> {
    try {
      if (item.status !== 'remote_verified') {
        const folderId = await this.drive.ensureFolderPath(item.path);
        const remoteFileId = await this.uploadQueuedPayload(item, folderId);
        markQueuedUploadVerified(item.id, remoteFileId);
      }
    } catch {
      incrementQueuedUpload(item.id);
      return false;
    }

    let metadata: UploadResult['metadata'] | null = null;
    if (item.ref && item.meta && typeof item.messageCount === 'number') {
      metadata = await this.finalizeSync(item.operationId ?? item.id, item.ref, item.meta, item.filename, {
        messageCount: item.messageCount,
        ...(item.contentHash ? { contentHash: item.contentHash } : {}),
        ...(item.hashVersion ? { hashVersion: item.hashVersion } : {})
      });
    }
    if (metadata !== 'failed') {
      removeQueuedUpload(item.id);
    }
    await this.cleanupAfterUpload(item.path);
    return true;
  }

  private async uploadQueuedPayload(item: QueuedChatUpload, folderId: string): Promise<string> {
    let remoteFileId = item.remoteFileId;
    if (!remoteFileId) {
      remoteFileId = await this.drive.generateFileId();
      setQueuedUploadRemoteId(item.id, remoteFileId);
    }
    try {
      const result = typeof item.package === 'string'
        ? await this.drive.uploadText(folderId, item.filename, item.package, item.mimeType, remoteFileId)
        : await this.drive.uploadJson(folderId, item.filename, item.package, remoteFileId);
      return result.id;
    } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 409) {
        throw error;
      }
      const existing = await this.drive.getFile(remoteFileId);
      if (!existing || existing.name !== item.filename || existing.parentId !== folderId) {
        throw new DriveError('既有 Drive 檔案與待傳工作不符', 409, 'upload_identity_mismatch');
      }
      return existing.id;
    }
  }

  private async performDownloadLatestAndReplace(target: ChatSyncTarget): Promise<DownloadResult> {
    this.assertCurrent(target.ref, target.contextRevision);
    const initialLocal = await this.tavern.exportRawChat(target.ref);
    const initialSnapshot = await createChatContentSnapshot(initialLocal.content);
    this.assertCurrent(target.ref, target.contextRevision);

    const path = driveChatPath(target.meta);
    const versions = await this.drive.listVersions(path);
    const latest = latestRawChatVersion(versions);
    if (!latest) {
      throw new Error('雲端沒有可下載的聊天版本');
    }

    const rawContent = latest.filename.endsWith('.jsonl')
      ? await this.drive.downloadText(latest.fileId)
      : null;
    if (rawContent === null) {
      unpackChatPackage(await this.drive.downloadJson(latest.fileId));
      throw new Error('舊版 .json 聊天包目前無法安全保存至指定聊天，更新未套用');
    }
    const remoteSnapshot = await createChatContentSnapshot(rawContent);

    this.assertCurrent(target.ref, target.contextRevision);
    const localBeforeRestore = await this.tavern.exportRawChat(target.ref);
    await this.assertUnchanged(initialSnapshot, localBeforeRestore.content);
    this.assertCurrent(target.ref, target.contextRevision);
    await this.uploadPreRestore(target.meta, localBeforeRestore);
    this.assertCurrent(target.ref, target.contextRevision);
    await this.assertUnchanged(initialSnapshot, (await this.tavern.exportRawChat(target.ref)).content);
    this.assertCurrent(target.ref, target.contextRevision);

    await this.tavern.replaceRawChat(rawContent, target.ref);
    // replaceRawChat 會重新載入目前聊天，宿主因此可能送出 CHAT_CHANGED 並
    // 推進 context revision。這是同一聊天完成覆寫後的正常 reload，不應再用
    // 操作開始前的 revision 否決同步紀錄；finalizeSync 仍會以目前 ref、內容
    // hash 與它在呼叫當下取得的新 revision 防止寫入其他聊天。
    let metadata = await this.finalizeSync(
      target.operationId,
      target.ref,
      target.meta,
      latest.filename,
      remoteSnapshot
    );
    if (metadata === 'deferred' && this.isCurrent(target.ref)) {
      await this.applyPendingReceiptsForCurrent();
      const current = this.ensureSyncMeta();
      if (
        current.last_synced_version === latest.filename
        && current.last_synced_content_hash === remoteSnapshot.contentHash
        && current.last_synced_hash_version === remoteSnapshot.hashVersion
      ) {
        metadata = 'applied';
      }
    }
    return {
      filename: latest.filename,
      metadata,
      status: metadata === 'applied' ? 'done' : 'partial'
    };
  }

  private async finalizeSync(
    operationId: string,
    ref: TavernChatRef,
    meta: ChatSyncMeta,
    filename: string,
    snapshot: { messageCount: number; contentHash?: string; hashVersion?: number },
    expectedContextRevision = getContextRevision()
  ): Promise<UploadResult['metadata']> {
    if (this.isCurrent(ref, expectedContextRevision)) {
      try {
        if (!snapshot.contentHash || !snapshot.hashVersion) {
          this.saveReceipt(operationId, ref, meta, filename, snapshot, 'superseded');
          return 'deferred';
        }
        const local = await createChatContentSnapshot((await this.tavern.exportRawChat(ref)).content);
        if (local.contentHash !== snapshot.contentHash || local.hashVersion !== snapshot.hashVersion) {
          this.saveReceipt(operationId, ref, meta, filename, snapshot, 'superseded');
          return 'deferred';
        }
        this.assertCurrent(ref, expectedContextRevision);
        const current = this.ensureSyncMeta();
        if (!current.last_synced_version || current.last_synced_version <= filename) {
          updateLastSyncedVersion(this.tavern, current, filename, snapshot.messageCount, {
            hash: snapshot.contentHash,
            version: snapshot.hashVersion
          });
        }
        return 'applied';
      } catch {
        if (!this.isCurrent(ref, expectedContextRevision)) {
          try {
            this.saveReceipt(operationId, ref, meta, filename, snapshot, 'pending');
            return 'deferred';
          } catch {
            return 'failed';
          }
        }
        return 'failed';
      }
    }
    try {
      this.saveReceipt(operationId, ref, meta, filename, snapshot, 'pending');
      return 'deferred';
    } catch {
      return 'failed';
    }
  }

  private saveReceipt(
    operationId: string,
    ref: TavernChatRef,
    meta: ChatSyncMeta,
    filename: string,
    snapshot: { messageCount: number; contentHash?: string; hashVersion?: number },
    status: 'pending' | 'superseded'
  ): void {
    saveSyncReceipt({
      id: operationId,
      ref,
      meta,
      filename,
      messageCount: snapshot.messageCount,
      createdAt: new Date().toISOString(),
      status,
      ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
      ...(snapshot.hashVersion ? { hashVersion: snapshot.hashVersion } : {})
    });
  }

  private async assertUnchanged(expected: ChatContentSnapshot, currentContent: string): Promise<void> {
    const current = await createChatContentSnapshot(currentContent);
    if (current.contentHash !== expected.contentHash || current.hashVersion !== expected.hashVersion) {
      throw new Error('等待更新期間本地聊天內容已變更，更新未套用');
    }
  }

  private async uploadPreRestore(meta: ChatSyncMeta, rawChat: RawChatFile): Promise<void> {
    const folderId = await this.drive.ensureFolderPath([
      'SillyTavernSync',
      meta.role_key,
      meta.chat_id,
      '_pre_restore',
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
    ]);
    await this.drive.uploadText(
      folderId,
      buildVersionFilename(loadSettings().deviceName, new Date(), 'jsonl'),
      rawChat.content,
      RAW_CHAT_MIME
    );
  }

  private async cleanupAfterUpload(path: string[]): Promise<UploadResult['cleanup']> {
    if (loadSettings().chatRetention.mode !== 'keep_latest_n') {
      return 'skipped';
    }
    try {
      await this.cleanupOldVersions(path);
      return 'done';
    } catch (error) {
      enqueueRetention(path, error);
      return 'pending';
    }
  }

  private async retryRetentionQueue(): Promise<void> {
    for (const task of loadRetentionQueue()) {
      try {
        await this.cleanupOldVersions(task.path);
        removeRetention(task.key);
      } catch (error) {
        enqueueRetention(task.path, error);
      }
    }
  }

  private async cleanupOldVersions(path: string[]): Promise<void> {
    const settings = loadSettings();
    if (settings.chatRetention.mode !== 'keep_latest_n') {
      return;
    }
    const versions = await this.drive.listVersions(path);
    const stale = versions.slice(0, Math.max(0, versions.length - settings.chatRetention.latestN));
    await mapWithConcurrency(stale, 4, version => this.drive.deleteFile(version.fileId));
  }

  private currentChatRef(): TavernChatRef {
    if (this.tavern.getCurrentChatRef) {
      return this.tavern.getCurrentChatRef();
    }
    const displayFileName = this.tavern.getCurrentChatFileName() ?? '';
    return {
      nativeChatId: displayFileName.replace(/\.jsonl?$/i, ''),
      rawFileName: displayFileName.endsWith('.jsonl') ? displayFileName : `${displayFileName}.jsonl`,
      displayFileName,
      avatarUrl: this.tavern.getCurrentCharacterName() ?? ''
    };
  }

  private isCurrent(ref: TavernChatRef, contextRevision?: number): boolean {
    if (contextRevision !== undefined && contextRevision !== getContextRevision()) return false;
    return this.tavern.isCurrentChat
      ? this.tavern.isCurrentChat(ref)
      : sameChatRef(this.currentChatRef(), ref);
  }

  private assertCurrent(ref: TavernChatRef, contextRevision?: number): void {
    if (!this.isCurrent(ref, contextRevision)) {
      throw new Error('聊天已切換，已中止更新以避免覆蓋其他聊天');
    }
  }
}

export function driveChatPath(meta: Pick<ChatSyncMeta, 'role_key' | 'chat_id'>): string[] {
  return ['SillyTavernSync', meta.role_key, meta.chat_id, 'chat'];
}

export function countJsonlMessages(content: string): number {
  return parseRawChatContent(content).messageCount;
}

function latestRawChatVersion<T extends { filename: string }>(versions: readonly T[]): T | null {
  return [...versions].reverse().find(version => version.filename.toLowerCase().endsWith('.jsonl')) ?? null;
}

function createOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

import { DriveError, type DriveItem } from '../drive/DriveClient';
import type { DriveService } from '../drive/DriveService';
import { parseUtcTimestamp } from '../drive/version';
import type {
  RestorePointBatch,
  RestorePointChatSummary,
  RestorePointCleanupPreview,
  RestorePointFile,
  RestorePointFileKind,
  RestorePointFolder,
  RestorePointMutationResult,
  RestorePointSelection,
  RestorePointTarget
} from './types';

const ROOT_FOLDER = 'SillyTavernSync';
const RESTORE_FOLDER = '_pre_restore';
const RESERVED_CHAT_FOLDERS = new Set(['_pre_restore', '_self_check']);
const RESTORE_POINT_KINDS = new Set<RestorePointFileKind>([
  'chat', 'character', 'world', 'persona', 'preset', 'regex'
]);

type DiscoveredTarget = RestorePointTarget & {
  roleFolderIds: Set<string>;
  chatFolderIds: Set<string>;
  restoreRoots: DriveItem[];
};

export class RestorePointService {
  constructor(private drive: DriveService) {}

  async listChats(): Promise<RestorePointChatSummary[]> {
    const targets = await this.discoverTargets();
    const summaries = await mapWithConcurrency([...targets.values()], 4, async target => {
      const batchFolders = await this.listBatchFolders(target.restoreRoots);
      const looseRoots = (await Promise.all(target.restoreRoots.map(async root => ({
        root,
        files: await this.drive.listFilesInFolder(root.id)
      })))).filter(item => item.files.length > 0);
      const latest = [...batchFolders.map(resolveBatchCreatedAt), ...looseRoots.map(item => normalizeDate(item.root.createdAt))]
        .sort((left, right) => right.localeCompare(left))[0] ?? null;
      return {
        key: targetKey(target),
        roleKey: target.roleKey,
        chatId: target.chatId,
        batchCount: batchFolders.length + looseRoots.length,
        latestCreatedAt: latest,
        restoreRootCount: target.restoreRoots.length,
        duplicatePath: target.roleFolderIds.size > 1 || target.chatFolderIds.size > 1 || target.restoreRoots.length > 1
      } satisfies RestorePointChatSummary;
    });
    return summaries.sort((left, right) => {
      const byLatest = (right.latestCreatedAt ?? '').localeCompare(left.latestCreatedAt ?? '');
      return byLatest || left.roleKey.localeCompare(right.roleKey) || left.chatId.localeCompare(right.chatId);
    });
  }

  async listChat(target: RestorePointTarget): Promise<RestorePointBatch[]> {
    assertTarget(target);
    const targets = await this.discoverTargets();
    const discovered = targets.get(targetKey(target));
    if (!discovered) return [];
    return this.listDiscoveredChat(discovered);
  }

  private async listDiscoveredChat(discovered: DiscoveredTarget): Promise<RestorePointBatch[]> {
    const folders = await this.listBatchFolders(discovered.restoreRoots);
    const [batches, loose] = await Promise.all([
      Promise.all(folders.map(folder => this.readBatch(folder, discovered))),
      Promise.all(discovered.restoreRoots.map(root => this.readLooseRootFiles(root, discovered)))
    ]);
    batches.push(...loose.filter((batch): batch is RestorePointBatch => Boolean(batch)));
    return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async previewCleanup(days: number, target?: RestorePointTarget, now = new Date()): Promise<RestorePointCleanupPreview> {
    if (!Number.isInteger(days) || days <= 0) throw new Error('保留天數必須是正整數');
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    const discovered = await this.discoverTargets();
    const selectedTargets = target
      ? [discovered.get(targetKey(target))].filter((item): item is DiscoveredTarget => Boolean(item))
      : [...discovered.values()];
    const batches = (await mapWithConcurrency(selectedTargets, 4, item => this.listDiscoveredChat(item))).flat();
    const files = batches.flatMap(batch => batch.files).filter(file => {
      const uploadedAt = Date.parse(file.uploadedAt);
      return Number.isFinite(uploadedAt) && uploadedAt < cutoff;
    });
    const targets = dedupeSelections(files.map(file => selectionFromFile(file)));
    return {
      days,
      scope: target ? 'chat' : 'all',
      targets,
      roleCount: new Set(files.map(file => file.roleKey)).size,
      chatCount: new Set(files.map(file => targetKey(file))).size,
      batchCount: new Set(files.map(file => file.batchFolderId)).size
    };
  }

  async trashFiles(selections: readonly RestorePointSelection[]): Promise<RestorePointMutationResult> {
    return this.mutateFiles(selections, fileId => this.drive.trashFile(fileId));
  }

  async deleteFilesPermanently(selections: readonly RestorePointSelection[]): Promise<RestorePointMutationResult> {
    return this.mutateFiles(selections, fileId => this.drive.deleteFile(fileId));
  }

  private async mutateFiles(
    selections: readonly RestorePointSelection[],
    operation: (fileId: string) => Promise<void>
  ): Promise<RestorePointMutationResult> {
    const requested = dedupeSelections(selections);
    if (requested.length === 0) return { requested: 0, affected: 0, failed: [] };
    await this.assertSelectionsBelongToTargets(requested);
    const settled = await Promise.all(requested.map(async selection => {
      try {
        await operation(selection.fileId);
        return { fileId: selection.fileId, affected: true as const };
      } catch (error) {
        if (error instanceof DriveError && error.status === 404) {
          return { fileId: selection.fileId, affected: true as const };
        }
        return {
          fileId: selection.fileId,
          affected: false as const,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
    return {
      requested: requested.length,
      affected: settled.filter(item => item.affected).length,
      failed: settled
        .filter((item): item is { fileId: string; affected: false; error: string } => !item.affected)
        .map(item => ({ fileId: item.fileId, error: item.error }))
    };
  }

  private async assertSelectionsBelongToTargets(selections: readonly RestorePointSelection[]): Promise<void> {
    const grouped = new Map<string, RestorePointSelection[]>();
    for (const selection of selections) {
      assertTarget(selection);
      const key = targetKey(selection);
      grouped.set(key, [...(grouped.get(key) ?? []), selection]);
    }
    const discovered = await this.discoverTargets();
    for (const [key, group] of grouped) {
      const target = group[0];
      if (!target) continue;
      const discoveredTarget = discovered.get(key);
      const batches = discoveredTarget ? await this.listDiscoveredChat(discoveredTarget) : [];
      const allowedIds = new Set(batches.flatMap(batch => batch.files.map(file => file.fileId)));
      const unknown = group.find(item => !allowedIds.has(item.fileId));
      if (unknown) {
        throw new Error(`檔案 ${unknown.fileId} 不屬於指定的 _pre_restore，已中止操作`);
      }
    }
  }

  private async discoverTargets(): Promise<Map<string, DiscoveredTarget>> {
    const targets = new Map<string, DiscoveredTarget>();
    const roles = await this.drive.listChildFolders([ROOT_FOLDER]);
    await Promise.all(roles.map(async role => {
      const chats = await this.drive.listFoldersInFolder(role.id);
      await Promise.all(chats
        .filter(chat => !RESERVED_CHAT_FOLDERS.has(chat.name))
        .map(async chat => {
          const restoreRoots = (await this.drive.listFoldersInFolder(chat.id))
            .filter(folder => folder.name === RESTORE_FOLDER);
          if (restoreRoots.length === 0) return;
          const key = targetKey({ roleKey: role.name, chatId: chat.name });
          const existing = targets.get(key) ?? {
            roleKey: role.name,
            chatId: chat.name,
            roleFolderIds: new Set<string>(),
            chatFolderIds: new Set<string>(),
            restoreRoots: []
          };
          existing.roleFolderIds.add(role.id);
          existing.chatFolderIds.add(chat.id);
          existing.restoreRoots.push(...restoreRoots);
          targets.set(key, existing);
        }));
    }));
    return targets;
  }

  private async listBatchFolders(restoreRoots: readonly DriveItem[]): Promise<DriveItem[]> {
    const folders = (await Promise.all(restoreRoots.map(root => this.drive.listFoldersInFolder(root.id)))).flat();
    return dedupeItems(folders);
  }

  private async readBatch(folder: DriveItem, target: RestorePointTarget): Promise<RestorePointBatch> {
    const directFiles = await this.drive.listFilesInFolder(folder.id);
    const childFolders = await this.drive.listFoldersInFolder(folder.id);
    const visited = new Set<string>([folder.id]);
    const nested = await Promise.all(childFolders.map(child => this.readNestedFolder(
      child,
      folder,
      target,
      child.name,
      restorePointKind(child.name),
      visited
    )));
    const files = [
      ...directFiles.map(file => toRestorePointFile(file, inferDirectKind(file), '', folder, target)),
      ...nested.flatMap(result => result.files)
    ].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
    const emptyFolders = nested.flatMap(result => result.emptyFolders);
    const issues: RestorePointBatch['issues'] = [];
    if (files.length === 0) issues.push('empty');
    if (!parseUtcTimestamp(folder.name)) issues.push('invalid_timestamp');
    if (directFiles.some(file => inferDirectKind(file) === 'other') || nested.some(result => result.hasUnknownItems)) {
      issues.push('unknown_items');
    }
    return {
      ...target,
      folderId: folder.id,
      name: folder.name,
      createdAt: resolveBatchCreatedAt(folder),
      files,
      emptyFolders,
      issues
    };
  }

  private async readLooseRootFiles(root: DriveItem, target: RestorePointTarget): Promise<RestorePointBatch | null> {
    const directFiles = await this.drive.listFilesInFolder(root.id);
    if (directFiles.length === 0) return null;
    const batchName = '_pre_restore 根目錄（未歸入批次）';
    const batch = { ...root, name: batchName };
    const files = directFiles
      .map(file => toRestorePointFile(file, inferDirectKind(file), '', batch, target))
      .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
    return {
      ...target,
      folderId: root.id,
      name: batchName,
      createdAt: normalizeDate(root.createdAt),
      files,
      emptyFolders: [],
      issues: ['invalid_timestamp', ...(files.some(file => file.kind === 'other') ? ['unknown_items' as const] : [])]
    };
  }

  private async readNestedFolder(
    folder: DriveItem,
    batch: DriveItem,
    target: RestorePointTarget,
    relativePath: string,
    kind: RestorePointFileKind,
    visited: Set<string>
  ): Promise<{ files: RestorePointFile[]; emptyFolders: RestorePointFolder[]; hasUnknownItems: boolean }> {
    if (visited.has(folder.id)) return { files: [], emptyFolders: [], hasUnknownItems: true };
    visited.add(folder.id);
    const [directFiles, childFolders] = await Promise.all([
      this.drive.listFilesInFolder(folder.id),
      this.drive.listFoldersInFolder(folder.id)
    ]);
    const nested = await Promise.all(childFolders.map(child => this.readNestedFolder(
      child,
      batch,
      target,
      `${relativePath}/${child.name}`,
      kind,
      visited
    )));
    const files = [
      ...directFiles.map(file => toRestorePointFile(file, kind, relativePath, batch, target)),
      ...nested.flatMap(result => result.files)
    ];
    const emptyFolders = nested.flatMap(result => result.emptyFolders);
    if (directFiles.length === 0 && childFolders.length === 0) {
      emptyFolders.push({
        folderId: folder.id,
        name: folder.name,
        relativePath,
        createdAt: normalizeDate(folder.createdAt),
        empty: true
      });
    }
    return {
      files,
      emptyFolders,
      hasUnknownItems: kind === 'other' || nested.some(result => result.hasUnknownItems)
    };
  }
}

function toRestorePointFile(
  file: DriveItem,
  kind: RestorePointFileKind,
  parentName: string,
  batch: DriveItem,
  target: RestorePointTarget
): RestorePointFile {
  return {
    ...target,
    fileId: file.id,
    filename: file.name,
    kind,
    relativePath: parentName ? `${parentName}/${file.name}` : file.name,
    batchFolderId: batch.id,
    batchName: batch.name,
    uploadedAt: normalizeDate(file.createdAt),
    updatedAt: normalizeDate(file.updatedAt)
  };
}

function inferDirectKind(file: DriveItem): RestorePointFileKind {
  return file.name.toLowerCase().endsWith('.jsonl') ? 'chat' : 'other';
}

function restorePointKind(folderName: string): RestorePointFileKind {
  return RESTORE_POINT_KINDS.has(folderName as RestorePointFileKind)
    ? folderName as RestorePointFileKind
    : 'other';
}

function resolveBatchCreatedAt(folder: DriveItem): string {
  return parseUtcTimestamp(folder.name)?.toISOString() ?? normalizeDate(folder.createdAt);
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '1970-01-01T00:00:00.000Z' : date.toISOString();
}

function targetKey(target: RestorePointTarget): string {
  return JSON.stringify([target.roleKey, target.chatId]);
}

function selectionFromFile(file: RestorePointFile): RestorePointSelection {
  return { fileId: file.fileId, roleKey: file.roleKey, chatId: file.chatId };
}

function dedupeSelections(selections: readonly RestorePointSelection[]): RestorePointSelection[] {
  const unique = new Map<string, RestorePointSelection>();
  for (const selection of selections) {
    if (selection.fileId) unique.set(selection.fileId, selection);
  }
  return [...unique.values()];
}

function dedupeItems(items: readonly DriveItem[]): DriveItem[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function assertTarget(target: RestorePointTarget): void {
  if (!target.roleKey.trim() || !target.chatId.trim()) throw new Error('還原點的角色與對話不可為空');
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  });
  await Promise.all(workers);
  return results;
}

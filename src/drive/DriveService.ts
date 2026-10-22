import { readScriptVariable, writeScriptVariable } from '../settings';
import { itemToVersion, sortVersions } from './version';
import { DriveError, type DriveClient, type DriveItem, type DriveVersion } from './DriveClient';

const FOLDER_CACHE_KEY = 'drive_folder_cache';

export class DriveService {
  constructor(private client: DriveClient) {}

  generateFileId(): Promise<string> {
    return this.client.generateFileId();
  }

  getFile(fileId: string): Promise<DriveItem | null> {
    return this.client.getFile(fileId);
  }

  async ensureFolderPath(path: string[]): Promise<string> {
    const normalized = normalizePath(path);
    const cacheKey = cacheKeyFor(normalized);
    const cache = loadFolderCache();

    let parentId: string | null = null;
    const resolvedPath: string[] = [];
    for (const segment of normalized) {
      resolvedPath.push(segment);
      const segmentKey = cacheKeyFor(resolvedPath);
      const cachedSegmentId = cache[segmentKey];
      const matchingFolders = await this.client.findFoldersByName(segment, parentId);
      const cachedFolder = cachedSegmentId
        ? matchingFolders.find(folder => folder.id === cachedSegmentId)
        : undefined;
      const folder: DriveItem = cachedFolder ?? matchingFolders[0] ?? (await this.ensureChildFolder(segment, parentId));
      parentId = folder.id;
      cache[segmentKey] = parentId;
      saveFolderCacheEntry(segmentKey, parentId);
    }

    if (!parentId) {
      throw new DriveError('Cannot resolve empty Drive path', 400, 'empty_path');
    }

    saveFolderCacheEntry(cacheKey, parentId);
    return parentId;
  }

  async resolveFolderPathAll(path: string[]): Promise<string[]> {
    const normalized = normalizePath(path);
    let parentIds: Array<string | null> = [null];

    for (const segment of normalized) {
      const next = await Promise.all(parentIds.map(parentId => this.client.findFoldersByName(segment, parentId)));
      parentIds = next.flat().map(folder => folder.id);
      if (parentIds.length === 0) {
        return [];
      }
    }

    return parentIds.filter((id): id is string => typeof id === 'string');
  }

  async listVersions(folderOrPath: string | string[]): Promise<DriveVersion[]> {
    const folderIds = Array.isArray(folderOrPath) ? await this.resolveFolderPathAll(folderOrPath) : [folderOrPath];
    const files = (await Promise.all(folderIds.map(folderId => this.client.listFiles(folderId)))).flat();
    const versions = files.map(itemToVersion).filter((version): version is DriveVersion => Boolean(version));
    return sortVersions(dedupeVersions(versions));
  }

  async listChildFolders(path: string[]): Promise<DriveItem[]> {
    const parentIds = await this.resolveFolderPathAll(path);
    const folders = (await Promise.all(parentIds.map(parentId => this.client.listFolders(parentId)))).flat();
    const seen = new Map<string, DriveItem>();
    for (const folder of folders) {
      if (!seen.has(folder.id)) {
        seen.set(folder.id, folder);
      }
    }
    return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async listFilesInFolder(folderId: string): Promise<DriveItem[]> {
    return this.client.listFiles(folderId);
  }

  async listFoldersInFolder(folderId: string): Promise<DriveItem[]> {
    return this.client.listFolders(folderId);
  }

  async uploadJson(folderId: string, filename: string, content: unknown, fileId?: string) {
    return this.client.uploadJson(folderId, filename, content, fileId);
  }

  async uploadText(folderId: string, filename: string, content: string, mimeType?: string, fileId?: string) {
    return this.client.uploadText(folderId, filename, content, mimeType, fileId);
  }

  async downloadJson<T = unknown>(fileId: string): Promise<T> {
    return this.client.downloadJson<T>(fileId);
  }

  async downloadText(fileId: string): Promise<string> {
    return this.client.downloadText(fileId);
  }

  async deleteFile(fileId: string): Promise<void> {
    return this.client.deleteFile(fileId);
  }

  async trashFile(fileId: string): Promise<void> {
    return this.client.trashFile(fileId);
  }

  clearFolderCache(): void {
    writeScriptVariable(FOLDER_CACHE_KEY, {});
  }

  private async ensureChildFolder(name: string, parentId: string | null): Promise<DriveItem> {
    const existing = await this.client.findFoldersByName(name, parentId);
    if (existing[0]) {
      return existing[0];
    }

    const created = await this.client.ensureFolder(name, parentId);
    const resolved = await this.client.findFoldersByName(name, parentId);
    return resolved.find(folder => folder.id === created.id) ?? resolved[0] ?? created;
  }
}

function normalizePath(path: string[]): string[] {
  const normalized = path.map(segment => segment.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new DriveError('Drive path cannot be empty', 400, 'empty_path');
  }
  return normalized;
}

function cacheKeyFor(path: string[]): string {
  return path.join('/');
}

function loadFolderCache(): Record<string, string> {
  const value = readScriptVariable(FOLDER_CACHE_KEY);
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return { ...(value as Record<string, string>) };
}

function saveFolderCacheEntry(key: string, folderId: string): void {
  writeScriptVariable(FOLDER_CACHE_KEY, { ...loadFolderCache(), [key]: folderId });
}

function dedupeVersions(versions: DriveVersion[]): DriveVersion[] {
  const seen = new Map<string, DriveVersion>();
  for (const version of versions) {
    seen.set(version.fileId, version);
  }
  return [...seen.values()];
}

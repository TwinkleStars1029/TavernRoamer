import { DriveError, type DriveClient, type DriveItem, type UploadResult } from './DriveClient';

const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export class MemoryDriveClient implements DriveClient {
  private items = new Map<string, DriveItem>();
  private nextId = 1;
  private nextError: DriveError | null = null;

  injectError(status: number, message = `Injected Drive error ${status}`): void {
    this.nextError = new DriveError(message, status, status === 401 ? 'unauthorized' : 'injected');
  }

  forceCreateFolder(name: string, parentId: string | null): DriveItem {
    return this.createItem({ name, parentId, type: 'folder' });
  }

  async findFoldersByName(name: string, parentId: string | null): Promise<DriveItem[]> {
    this.throwIfNeeded();
    return [...this.items.values()].filter(
      item => item.type === 'folder' && item.name === name && item.parentId === parentId
    );
  }

  async ensureFolder(name: string, parentId: string | null): Promise<DriveItem> {
    this.throwIfNeeded();
    const existing = [...this.items.values()].find(
      item => item.type === 'folder' && item.name === name && item.parentId === parentId
    );
    if (existing) {
      return existing;
    }
    return this.createItem({ name, parentId, type: 'folder' });
  }

  async uploadJson(parentId: string, name: string, data: unknown): Promise<UploadResult> {
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return this.uploadText(parentId, name, content, 'application/json');
  }

  async uploadText(
    parentId: string,
    name: string,
    content: string,
    mimeType = 'text/plain; charset=UTF-8'
  ): Promise<UploadResult> {
    this.throwIfNeeded();
    this.assertFolder(parentId);
    const item = this.createItem({
      name,
      parentId,
      type: 'file',
      mimeType,
      content
    });
    return {
      ...item,
      uploadKind: new TextEncoder().encode(content).byteLength > RESUMABLE_THRESHOLD_BYTES ? 'resumable' : 'multipart'
    };
  }

  async listFiles(parentId: string): Promise<DriveItem[]> {
    this.throwIfNeeded();
    this.assertFolder(parentId);
    return [...this.items.values()]
      .filter(item => item.type === 'file' && item.parentId === parentId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async downloadJson<T = unknown>(fileId: string): Promise<T> {
    this.throwIfNeeded();
    const item = this.items.get(fileId);
    if (!item || item.type !== 'file') {
      throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
    }
    return JSON.parse(item.content ?? 'null') as T;
  }

  async downloadText(fileId: string): Promise<string> {
    this.throwIfNeeded();
    const item = this.items.get(fileId);
    if (!item || item.type !== 'file') {
      throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
    }
    return item.content ?? '';
  }

  async deleteFile(fileId: string): Promise<void> {
    this.throwIfNeeded();
    const item = this.items.get(fileId);
    if (!item || item.type !== 'file') {
      throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
    }
    this.items.delete(fileId);
  }

  snapshot(): DriveItem[] {
    return [...this.items.values()].map(item => ({ ...item }));
  }

  private createItem(input: Omit<DriveItem, 'id' | 'createdAt' | 'updatedAt'>): DriveItem {
    const now = new Date().toISOString();
    const item: DriveItem = {
      ...input,
      id: `mem_${this.nextId++}`,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(item.id, item);
    return item;
  }

  private throwIfNeeded(): void {
    if (!this.nextError) {
      return;
    }
    const error = this.nextError;
    this.nextError = null;
    throw error;
  }

  private assertFolder(folderId: string): void {
    const folder = this.items.get(folderId);
    if (!folder || folder.type !== 'folder') {
      throw new DriveError(`Folder not found: ${folderId}`, 404, 'not_found');
    }
  }
}

import { DriveError, type DriveClient, type DriveItem, type UploadResult } from './DriveClient';

const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export class MemoryDriveClient implements DriveClient {
  private items = new Map<string, DriveItem>();
  private nextId = 1;
  private nextError: DriveError | null = null;

  async generateFileId(): Promise<string> {
    this.throwIfNeeded();
    return `mem_generated_${this.nextId++}`;
  }

  async getFile(fileId: string): Promise<DriveItem | null> {
    this.throwIfNeeded();
    const item = this.items.get(fileId);
    return item ? { ...item } : null;
  }

  injectError(status: number, message = `Injected Drive error ${status}`): void {
    this.nextError = new DriveError(message, status, status === 401 ? 'unauthorized' : 'injected');
  }

  forceCreateFolder(name: string, parentId: string | null): DriveItem {
    return this.createItem({ name, parentId, type: 'folder' });
  }

  forceSetTimes(fileId: string, createdAt: string, updatedAt = createdAt): void {
    const item = this.items.get(fileId);
    if (!item) throw new DriveError(`Item not found: ${fileId}`, 404, 'not_found');
    this.items.set(fileId, { ...item, createdAt, updatedAt });
  }

  async findFoldersByName(name: string, parentId: string | null): Promise<DriveItem[]> {
    this.throwIfNeeded();
    return [...this.items.values()].filter(
      item => !item.trashed && item.type === 'folder' && item.name === name && item.parentId === parentId
    );
  }

  async ensureFolder(name: string, parentId: string | null): Promise<DriveItem> {
    this.throwIfNeeded();
    const existing = [...this.items.values()].find(
      item => !item.trashed && item.type === 'folder' && item.name === name && item.parentId === parentId
    );
    if (existing) {
      return existing;
    }
    return this.createItem({ name, parentId, type: 'folder' });
  }

  async uploadJson(parentId: string, name: string, data: unknown, fileId?: string): Promise<UploadResult> {
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return this.uploadText(parentId, name, content, 'application/json', fileId);
  }

  async uploadText(
    parentId: string,
    name: string,
    content: string,
    mimeType = 'text/plain; charset=UTF-8',
    fileId?: string
  ): Promise<UploadResult> {
    this.throwIfNeeded();
    this.assertFolder(parentId);
    if (fileId && this.items.has(fileId)) {
      throw new DriveError(`File already exists: ${fileId}`, 409, 'already_exists');
    }
    const item = this.createItem({
      name,
      parentId,
      type: 'file',
      mimeType,
      content,
      ...(fileId ? { id: fileId } : {})
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
      .filter(item => !item.trashed && item.type === 'file' && item.parentId === parentId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listFolders(parentId: string | null): Promise<DriveItem[]> {
    this.throwIfNeeded();
    return [...this.items.values()]
      .filter(item => !item.trashed && item.type === 'folder' && item.parentId === parentId)
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

  async trashFile(fileId: string): Promise<void> {
    this.throwIfNeeded();
    const item = this.items.get(fileId);
    if (!item || item.type !== 'file' || item.trashed) {
      throw new DriveError(`File not found: ${fileId}`, 404, 'not_found');
    }
    this.items.set(fileId, { ...item, trashed: true, updatedAt: new Date().toISOString() });
  }

  snapshot(): DriveItem[] {
    return [...this.items.values()].map(item => ({ ...item }));
  }

  private createItem(input: Omit<DriveItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): DriveItem {
    const now = new Date().toISOString();
    const item: DriveItem = {
      ...input,
      id: input.id ?? `mem_${this.nextId++}`,
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

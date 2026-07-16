export type DriveItemType = 'folder' | 'file';

export type DriveItem = {
  id: string;
  name: string;
  parentId: string | null;
  type: DriveItemType;
  mimeType?: string;
  content?: string;
  createdAt: string;
  updatedAt: string;
};

export type DriveVersion = {
  fileId: string;
  filename: string;
  uploadedAt: Date;
  uploadedAtUtc: string;
  device: string;
  size?: number;
};

export type UploadKind = 'multipart' | 'resumable';

export type UploadResult = DriveItem & {
  uploadKind: UploadKind;
};

export type DriveClient = {
  findFoldersByName(name: string, parentId: string | null): Promise<DriveItem[]>;
  ensureFolder(name: string, parentId: string | null): Promise<DriveItem>;
  uploadJson(parentId: string, name: string, data: unknown): Promise<UploadResult>;
  uploadText(parentId: string, name: string, content: string, mimeType?: string): Promise<UploadResult>;
  listFiles(parentId: string): Promise<DriveItem[]>;
  downloadJson<T = unknown>(fileId: string): Promise<T>;
  downloadText(fileId: string): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
};

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'drive_error'
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

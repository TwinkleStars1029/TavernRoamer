import { DriveError, type DriveClient, type DriveItem, type UploadKind, type UploadResult } from './DriveClient';
import { withDriveRetry, type RetryOptions } from './retry';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export type AccessTokenProvider = {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string | null>;
};

export type GoogleDriveClientOptions = {
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  retry?: Omit<RetryOptions, 'onUnauthorized'>;
};

type GoogleFile = {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
};

export class GoogleDriveClient implements DriveClient {
  private fetchImpl: typeof fetch;

  constructor(private options: GoogleDriveClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async generateFileId(): Promise<string> {
    const result = await this.requestJson<{ ids?: string[] }>(`${DRIVE_API}/files/generateIds?count=1&space=drive&type=files`);
    const id = result.ids?.[0];
    if (!id) {
      throw new DriveError('Drive did not return a generated file ID', 502, 'missing_generated_id');
    }
    return id;
  }

  async getFile(fileId: string): Promise<DriveItem | null> {
    try {
      const file = await this.requestJson<GoogleFile>(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,createdTime,modifiedTime,size`
      );
      return toDriveItem(file);
    } catch (error) {
      if (error instanceof DriveError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findFoldersByName(name: string, parentId: string | null): Promise<DriveItem[]> {
    const query = [
      `name = '${escapeDriveQueryString(name)}'`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
      parentId ? `'${escapeDriveQueryString(parentId)}' in parents` : "'root' in parents"
    ].join(' and ');
    const files = await this.listRaw(query);
    return files.map(toDriveItem);
  }

  async ensureFolder(name: string, parentId: string | null): Promise<DriveItem> {
    const existing = await this.findFoldersByName(name, parentId);
    if (existing[0]) {
      return existing[0];
    }

    const metadata = {
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : undefined
    };
    const created = await this.requestJson<GoogleFile>(`${DRIVE_API}/files?fields=id,name,mimeType,parents,createdTime,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    return toDriveItem(created);
  }

  async uploadJson(parentId: string, name: string, data: unknown, fileId?: string): Promise<UploadResult> {
    const content = JSON.stringify(data, null, 2);
    return this.uploadText(parentId, name, content, 'application/json', fileId);
  }

  async uploadText(
    parentId: string,
    name: string,
    content: string,
    mimeType = 'text/plain; charset=UTF-8',
    fileId?: string
  ): Promise<UploadResult> {
    const size = new TextEncoder().encode(content).byteLength;
    if (size > RESUMABLE_THRESHOLD_BYTES) {
      return this.uploadResumable(parentId, name, content, mimeType, fileId);
    }
    return this.uploadMultipart(parentId, name, content, mimeType, fileId);
  }

  async listFiles(parentId: string): Promise<DriveItem[]> {
    const query = [
      `'${escapeDriveQueryString(parentId)}' in parents`,
      `mimeType != '${FOLDER_MIME}'`,
      'trashed = false'
    ].join(' and ');
    const files = await this.listRaw(query);
    return files.map(toDriveItem).sort((left, right) => left.name.localeCompare(right.name));
  }

  async listFolders(parentId: string | null): Promise<DriveItem[]> {
    const query = [
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
      parentId ? `'${escapeDriveQueryString(parentId)}' in parents` : "'root' in parents"
    ].join(' and ');
    const files = await this.listRaw(query);
    return files.map(toDriveItem).sort((left, right) => left.name.localeCompare(right.name));
  }

  async downloadJson<T = unknown>(fileId: string): Promise<T> {
    return this.requestJson<T>(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
  }

  async downloadText(fileId: string): Promise<string> {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.text();
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  }

  async trashFile(fileId: string): Promise<void> {
    await this.requestJson<GoogleFile>(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      }
    );
  }

  async getAccountEmail(): Promise<string | null> {
    try {
      const about = await this.requestJson<{ user?: { emailAddress?: string } }>(
        `${DRIVE_API}/about?fields=user(emailAddress,displayName)`
      );
      return about.user?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  private async listRaw(query: string): Promise<GoogleFile[]> {
    const params = new URLSearchParams({
      q: query,
      spaces: 'drive',
      fields: 'files(id,name,mimeType,parents,createdTime,modifiedTime,size)',
      pageSize: '1000'
    });
    const result = await this.requestJson<{ files?: GoogleFile[] }>(`${DRIVE_API}/files?${params.toString()}`);
    return result.files ?? [];
  }

  private async uploadMultipart(
    parentId: string,
    name: string,
    content: string,
    mimeType: string,
    fileId?: string
  ): Promise<UploadResult> {
    const boundary = `tavern_roamer_${Date.now().toString(36)}`;
    const metadata = {
      id: fileId,
      name,
      parents: [parentId],
      mimeType
    };
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      content,
      `--${boundary}--`
    ].join('\r\n');
    const file = await this.requestJson<GoogleFile>(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,parents,createdTime,modifiedTime,size`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      }
    );
    return withUploadKind(toDriveItem(file), 'multipart');
  }

  private async uploadResumable(
    parentId: string,
    name: string,
    content: string,
    mimeType: string,
    fileId?: string
  ): Promise<UploadResult> {
    const bytes = new TextEncoder().encode(content);
    const session = await this.request(
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,parents,createdTime,modifiedTime,size`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(bytes.byteLength)
        },
        body: JSON.stringify({ id: fileId, name, parents: [parentId], mimeType })
      }
    );
    const uploadUrl = session.headers.get('Location');
    if (!uploadUrl) {
      throw new DriveError('Drive resumable upload did not return a session URL', 502, 'missing_upload_location');
    }
    const uploaded = await this.requestJson<GoogleFile>(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(bytes.byteLength)
      },
      body: content
    });
    return withUploadKind(toDriveItem(uploaded), 'resumable');
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return withDriveRetry(
      async () => {
        const token = await this.options.tokenProvider.getAccessToken();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        const response = await this.fetchImpl(url, { ...init, headers });
        if (!response.ok) {
          throw new DriveError(await errorMessage(response), response.status, 'http_error');
        }
        return response;
      },
      {
        ...this.options.retry,
        onUnauthorized: async () => Boolean(await this.options.tokenProvider.refreshAccessToken())
      }
    );
  }
}

function toDriveItem(file: GoogleFile): DriveItem {
  const item: DriveItem = {
    id: file.id,
    name: file.name,
    parentId: file.parents?.[0] ?? null,
    type: file.mimeType === FOLDER_MIME ? 'folder' : 'file',
    createdAt: file.createdTime ?? new Date().toISOString(),
    updatedAt: file.modifiedTime ?? file.createdTime ?? new Date().toISOString()
  };
  if (file.mimeType) {
    item.mimeType = file.mimeType;
  }
  if (typeof file.trashed === 'boolean') {
    item.trashed = file.trashed;
  }
  return item;
}

function withUploadKind(item: DriveItem, uploadKind: UploadKind): UploadResult {
  return { ...item, uploadKind };
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Drive API request failed with ${response.status}`;
  } catch {
    return `Drive API request failed with ${response.status}`;
  }
}

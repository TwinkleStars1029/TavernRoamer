import type { DriveVersion } from '../drive/DriveClient';
import type { DriveService } from '../drive/DriveService';
import { mapWithConcurrency } from '../drive/concurrency';

export type CloudRoleEntry = {
  roleKey: string;
};

export type CloudChatEntry = {
  chatId: string;
  versionCount: number;
  latest: DriveVersion | null;
};

const ROOT_FOLDER = 'SillyTavernSync';
// 非聊天資料的功能性資料夾，瀏覽清單不列出
const EXCLUDED_FOLDERS = new Set(['_pre_restore', '_self_check']);

export async function listCloudRoles(drive: DriveService): Promise<CloudRoleEntry[]> {
  const folders = await drive.listChildFolders([ROOT_FOLDER]);
  const names = [...new Set(folders.map(folder => folder.name))].filter(name => !EXCLUDED_FOLDERS.has(name));
  return names.map(roleKey => ({ roleKey }));
}

export async function listCloudChats(drive: DriveService, roleKey: string): Promise<CloudChatEntry[]> {
  const folders = await drive.listChildFolders([ROOT_FOLDER, roleKey]);
  const chatIds = [...new Set(folders.map(folder => folder.name))].filter(name => !EXCLUDED_FOLDERS.has(name));
  const entries = await mapWithConcurrency(
    chatIds,
    4,
    async chatId => {
      const versions = await drive.listVersions([ROOT_FOLDER, roleKey, chatId, 'chat']);
      const rawVersions = versions.filter(version => version.filename.toLowerCase().endsWith('.jsonl'));
      return { chatId, versionCount: rawVersions.length, latest: rawVersions.at(-1) ?? null } satisfies CloudChatEntry;
    }
  );
  // 最新更新的窗排前面；沒版本的排最後
  return entries.sort((left, right) => (right.latest?.filename ?? '').localeCompare(left.latest?.filename ?? ''));
}

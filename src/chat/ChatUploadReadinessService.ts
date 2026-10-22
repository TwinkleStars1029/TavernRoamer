import type { DriveService } from '../drive/DriveService';
import { environmentItemPath } from '../environment/EnvironmentBackupService';
import { ENVIRONMENT_ITEM_KINDS, type EnvironmentItemKind } from '../environment/types';
import type { ChatSyncTarget } from './context';
import { driveChatPath } from './ChatSyncService';

export type EnvironmentAvailability = {
  kind: EnvironmentItemKind;
  available: boolean;
  latestFilename: string | null;
};

export type ChatUploadReadiness = {
  target: ChatSyncTarget;
  isFirstUpload: boolean;
  latestChatFilename: string | null;
  environment: EnvironmentAvailability[];
  recoveryStatus: 'ready' | 'missing_character' | 'first_upload';
};

export class ChatUploadReadinessService {
  constructor(private drive: Pick<DriveService, 'listVersions'>) {}

  async inspect(target: ChatSyncTarget): Promise<ChatUploadReadiness> {
    const [chatVersions, ...environmentVersions] = await Promise.all([
      this.drive.listVersions(driveChatPath(target.meta)),
      ...ENVIRONMENT_ITEM_KINDS.map(kind => this.drive.listVersions(environmentItemPath(target.meta, kind)))
    ]);
    const latestChat = [...chatVersions].reverse().find(version => version.filename.endsWith('.jsonl')) ?? null;
    const environment = ENVIRONMENT_ITEM_KINDS.map((kind, index): EnvironmentAvailability => {
      const latest = environmentVersions[index]?.at(-1) ?? null;
      return {
        kind,
        available: Boolean(latest),
        latestFilename: latest?.filename ?? null
      };
    });
    const hasCharacter = environment.find(item => item.kind === 'character')?.available ?? false;
    return {
      target,
      isFirstUpload: !latestChat,
      latestChatFilename: latestChat?.filename ?? null,
      environment,
      recoveryStatus: !latestChat ? 'first_upload' : hasCharacter ? 'ready' : 'missing_character'
    };
  }
}

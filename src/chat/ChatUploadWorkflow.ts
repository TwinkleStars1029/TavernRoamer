import type { EnvironmentBackupOptions, EnvironmentBackupResult } from '../environment/EnvironmentBackupService';
import type { EnvironmentItemKind, EnvironmentProgressEvent } from '../environment/types';
import type { UploadResult } from './ChatSyncService';
import type { ChatSyncTarget } from './context';
import type { ChatUploadReadiness, ChatUploadReadinessService } from './ChatUploadReadinessService';

type ChatUploadServicePort = {
  captureCurrentChat: () => ChatSyncTarget;
  assertTargetCurrent: (target: ChatSyncTarget) => void;
  uploadChat: (target: ChatSyncTarget, options?: { queueOnFail?: boolean }) => Promise<UploadResult>;
};

type EnvironmentBackupPort = {
  backupItems: (
    kinds: readonly EnvironmentItemKind[],
    options?: EnvironmentBackupOptions
  ) => Promise<EnvironmentBackupResult[]>;
};

type ReadinessPort = Pick<ChatUploadReadinessService, 'inspect'>;

export type ChatUploadPreparation = ChatUploadReadiness & {
  preparationId: string;
};

export type ChatUploadWorkflowRequest = {
  preparationId: string;
  selectedEnvironment: EnvironmentItemKind[];
  chatOnly: boolean;
  onProgress?: (event: EnvironmentProgressEvent) => void;
};

export type ChatUploadWorkflowResult = {
  status: 'done' | 'partial' | 'queued' | 'aborted';
  environmentResults: EnvironmentBackupResult[];
  chatResult: UploadResult | null;
  recoveryStatus: 'ready' | 'missing_character';
};

type StoredPreparation = {
  preparation: ChatUploadPreparation;
  running: boolean;
};

export class ChatUploadWorkflow {
  private preparations = new Map<string, StoredPreparation>();

  constructor(
    private chatSync: ChatUploadServicePort,
    private environmentBackup: EnvironmentBackupPort,
    private readiness: ReadinessPort
  ) {}

  async prepare(): Promise<ChatUploadPreparation> {
    this.preparations.clear();
    const target = this.chatSync.captureCurrentChat();
    const readiness = await this.readiness.inspect(target);
    this.chatSync.assertTargetCurrent(target);
    const preparation: ChatUploadPreparation = {
      ...readiness,
      preparationId: createPreparationId()
    };
    this.preparations.set(preparation.preparationId, { preparation, running: false });
    return preparation;
  }

  invalidateAll(): void {
    this.preparations.clear();
  }

  async execute(request: ChatUploadWorkflowRequest): Promise<ChatUploadWorkflowResult> {
    const stored = this.preparations.get(request.preparationId);
    if (!stored) {
      throw new Error('上傳確認已過期，請重新檢查目前聊天');
    }
    if (stored.running) {
      throw new Error('這次上傳已在執行中');
    }
    stored.running = true;

    try {
      const target = stored.preparation.target;
      this.chatSync.assertTargetCurrent(target);
      const latestReadiness = await this.readiness.inspect(target);
      this.chatSync.assertTargetCurrent(target);

      const selectedEnvironment = uniqueKinds(request.selectedEnvironment);
      const environmentResults = request.chatOnly || selectedEnvironment.length === 0
        ? []
        : await this.environmentBackup.backupItems(selectedEnvironment, {
            meta: target.meta,
            ...(request.onProgress ? { onProgress: request.onProgress } : {})
          });

      const existingCharacter = latestReadiness.environment.find(item => item.kind === 'character')?.available ?? false;
      const characterResult = environmentResults.find(item => item.kind === 'character');
      const characterAvailable = existingCharacter || characterResult?.status === 'done';
      if (!request.chatOnly && characterResult?.status === 'error' && !existingCharacter) {
        return {
          status: 'aborted',
          environmentResults,
          chatResult: null,
          recoveryStatus: 'missing_character'
        };
      }

      this.chatSync.assertTargetCurrent(target);
      const chatResult = await this.chatSync.uploadChat(target, { queueOnFail: true });
      const environmentFailed = environmentResults.some(result => result.status === 'error');
      const chatPartial = chatResult.cleanup === 'pending' || chatResult.metadata !== 'applied';
      return {
        status: chatResult.queued ? 'queued' : environmentFailed || chatPartial ? 'partial' : 'done',
        environmentResults,
        chatResult,
        recoveryStatus: characterAvailable ? 'ready' : 'missing_character'
      };
    } finally {
      this.preparations.delete(request.preparationId);
    }
  }
}

function uniqueKinds(kinds: readonly EnvironmentItemKind[]): EnvironmentItemKind[] {
  return [...new Set(kinds)];
}

function createPreparationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `upload_preparation_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

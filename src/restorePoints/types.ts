export type RestorePointFileKind = 'chat' | 'character' | 'world' | 'persona' | 'preset' | 'regex' | 'other';

export type RestorePointTarget = {
  roleKey: string;
  chatId: string;
};

export type RestorePointSelection = RestorePointTarget & {
  fileId: string;
};

export type RestorePointChatSummary = RestorePointTarget & {
  key: string;
  batchCount: number;
  latestCreatedAt: string | null;
  restoreRootCount: number;
  duplicatePath: boolean;
};

export type RestorePointFile = RestorePointSelection & {
  filename: string;
  kind: RestorePointFileKind;
  relativePath: string;
  batchFolderId: string;
  batchName: string;
  uploadedAt: string;
  updatedAt: string;
};

export type RestorePointFolder = {
  folderId: string;
  name: string;
  relativePath: string;
  createdAt: string;
  empty: boolean;
};

export type RestorePointBatch = RestorePointTarget & {
  folderId: string;
  name: string;
  createdAt: string;
  files: RestorePointFile[];
  emptyFolders: RestorePointFolder[];
  issues: Array<'empty' | 'unknown_items' | 'invalid_timestamp'>;
};

export type RestorePointMutationResult = {
  requested: number;
  affected: number;
  failed: Array<{ fileId: string; error: string }>;
};

export type RestorePointCleanupPreview = {
  days: number;
  scope: 'all' | 'chat';
  targets: RestorePointSelection[];
  roleCount: number;
  chatCount: number;
  batchCount: number;
};

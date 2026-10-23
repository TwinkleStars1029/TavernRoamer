export {
  buildSelfCheckReport,
  createPanel,
  floatingHostLayout,
  formatAutoSyncLabel,
  formatPendingLabel,
  progressRatioLabel,
  renderCloudChatListHtml,
  renderCloudRoleListHtml,
  renderPanel,
  renderRestorePointChatListHtml,
  renderRestorePointListHtml,
  renderRestorePreviewErrorHtml,
  renderRestorePreviewHtml,
  renderChatUploadPreparationHtml,
  renderSelfCheckResultsHtml,
  renderUploadPreviewHtml,
  statusPill,
  summarizeProgress,
  summarizeSelfChecks,
  uploadCompletionMessage
} from './ui/panelController';

export type {
  PanelController,
  PanelHealth,
  PanelOptions,
  SelfCheckProgressView
} from './ui/types';
export type { PillTone, ProgressSummary, SelfCheckSummary } from './ui/panelController';

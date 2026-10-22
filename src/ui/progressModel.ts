export type ProgressOp = 'backup' | 'restore' | 'upload' | 'download' | 'pull';
export type ProgressRowState = 'pending' | 'active' | 'done' | 'queued' | 'warning' | 'error' | 'aborted' | 'skipped';

export type ProgressRow = {
  key: string;
  label: string;
  state: ProgressRowState;
  detail: string;
  canRetry: boolean;
};

export function isSettledProgressState(state: ProgressRowState): boolean {
  return state === 'done' || state === 'queued' || state === 'warning' || state === 'error' || state === 'aborted' || state === 'skipped';
}

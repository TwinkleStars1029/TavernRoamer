import { ENVIRONMENT_ITEM_KINDS, type EnvironmentItemKind } from '../environment/types';

export type EnvironmentPresentation = {
  label: string;
  description: string;
};

export const ENVIRONMENT_PRESENTATION: Record<EnvironmentItemKind, EnvironmentPresentation> = {
  character: { label: '角色卡', description: '角色資料與頭像；其他裝置建立聊天所需' },
  world: { label: '世界書', description: '世界書、Lorebook 與角色綁定' },
  persona: { label: 'Persona', description: '使用者 Persona，可能包含個人資料' },
  preset: { label: 'Preset', description: '生成與提示詞預設' },
  regex: { label: 'Regex', description: '全域 Regex 腳本設定' }
};

export const ENVIRONMENT_ITEM_ORDER: readonly EnvironmentItemKind[] = ENVIRONMENT_ITEM_KINDS;

export function environmentLabel(kind: EnvironmentItemKind): string {
  return ENVIRONMENT_PRESENTATION[kind].label;
}

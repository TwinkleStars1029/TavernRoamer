import type { EnvironmentContextPort } from '../../environment/EnvironmentPort';
import { chatRefKey } from '../../chat/context';
import { getCurrentRawChatInfo } from '../chatRef';
import { getSillyTavernContext } from '../host';
import { getContextRevision } from '../../contextRevision';

export function createEnvironmentContextAdapter(): EnvironmentContextPort {
  return {
    captureEnvironmentContext() {
      return captureEnvironmentContextKey();
    },
    isEnvironmentContextCurrent(contextKey) {
      try {
        return captureEnvironmentContextKey() === contextKey;
      } catch {
        return false;
      }
    }
  };
}

function captureEnvironmentContextKey(): string {
  try {
    return JSON.stringify([getContextRevision(), chatRefKey(getCurrentRawChatInfo())]);
  } catch {
    const context = getSillyTavernContext();
    return JSON.stringify([
      getContextRevision(),
      context?.characterId ?? null,
      context?.chatId ?? context?.getCurrentChatId?.() ?? null,
      context?.name2 ?? null
    ]);
  }
}

export function assertEnvironmentContext(contextKey?: string): void {
  if (!contextKey) return;
  const current = captureEnvironmentContextKey();
  if (current !== contextKey) throw new Error('操作期間角色或聊天已切換，環境還原已中止');
}

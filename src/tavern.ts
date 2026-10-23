import type { TavernShellPort } from './app/TavernShellPort';
import type { ChatPullPort } from './chat/ports/ChatPullPort';
import type { ChatSyncPort } from './chat/ports/ChatSyncPort';
import type { EnvironmentPort } from './environment/EnvironmentPort';
import { createTavernPullAdapter } from './tavern/chatPull';
import { createTavernServices } from './tavern/factory';

/** Compatibility type for callers that still request the combined adapter. */
export type TavernChatAdapter = ChatSyncPort & EnvironmentPort;
export type TavernPullAdapter = ChatPullPort;
export type TavernApi = TavernShellPort & {
  getChatAdapter: () => TavernChatAdapter;
};

/** Compatibility façade. New composition code should use createTavernServices. */
export function createTavernApi(): TavernApi {
  const services = createTavernServices();
  const adapter: TavernChatAdapter = { ...services.chatSync, ...services.environment };
  return { ...services.shell, getChatAdapter: () => adapter };
}

export { createTavernPullAdapter, createTavernServices };
export type { TavernServices } from './tavern/factory';
export type { TavernCapabilities } from './tavern/capabilities';

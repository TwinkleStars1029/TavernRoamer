import type { TavernShellPort } from '../app/TavernShellPort';
import type { TavernDiagnosticsPort } from '../app/TavernDiagnosticsPort';
import type { ChatPullPort } from '../chat/ports/ChatPullPort';
import type { ChatSyncPort } from '../chat/ports/ChatSyncPort';
import type { EnvironmentPort } from '../environment/EnvironmentPort';
import { detectTavernCapabilities, type TavernCapabilities } from './capabilities';
import { createTavernPullAdapter } from './chatPull';
import { createChatSyncAdapter } from './chatSync';
import { createEnvironmentAdapter } from './environment';
import { createTavernShell } from './shell';
import { createTavernDiagnostics } from './diagnostics';

export type TavernServices = {
  shell: TavernShellPort;
  chatSync: ChatSyncPort;
  chatPull: ChatPullPort;
  environment: EnvironmentPort;
  capabilities: TavernCapabilities;
  diagnostics: TavernDiagnosticsPort;
};

export function createTavernServices(): TavernServices {
  return {
    shell: createTavernShell(),
    chatSync: createChatSyncAdapter(),
    chatPull: createTavernPullAdapter(),
    environment: createEnvironmentAdapter(),
    capabilities: detectTavernCapabilities(),
    diagnostics: createTavernDiagnostics()
  };
}

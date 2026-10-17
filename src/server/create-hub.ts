import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import { createCodexSessionManager } from "./adapters/codex/session-manager.js";
import {
  SessionReadService,
  type SessionReadServiceDependencies,
} from "./application/session-read-service.js";
import { SessionCatalogService } from "./catalog/session-catalog-service.js";
import { SessionInteractionService } from "./interaction/interaction-service.js";
import { TmuxInteractionService } from "./interaction/tmux-service.js";
import { SessionLiveService } from "./live/session-live-service.js";
import { OperationService } from "./management/operation-service.js";
import { SessionManagerRegistry } from "./management/session-manager.js";
import type { SessionSource } from "./source/session-source.js";

function createSessionReadService(
  sources: readonly SessionSource[],
  dependencies?: SessionReadServiceDependencies,
): SessionReadService {
  return new SessionReadService(sources, undefined, undefined, dependencies);
}

export async function createCodexSessionReadService(
  codexHome: string,
): Promise<SessionReadService> {
  const source = await createCodexSessionSource(codexHome);
  return createSessionReadService([source], {
    resolveNickname: (session) => source.nicknameFor(session),
  });
}

/** Compose reading and management using the adapter's published source identity. */
export async function createCodexHub(
  codexHome: string,
  socket?: string,
  interactionEnabled = true,
) {
  const source = await createCodexSessionSource(codexHome);
  const sessions = createSessionReadService([source], {
    resolveNickname: (session) => source.nicknameFor(session),
  });
  const managers = new SessionManagerRegistry(source.descriptor.sourceInstanceId).register(
    source.descriptor.sourceInstanceId,
    createCodexSessionManager(codexHome, socket),
  );
  const transport = new TmuxInteractionService();
  const interaction = new SessionInteractionService(sessions, interactionEnabled, transport);
  const cleanup: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const release of cleanup) release();
  };
  try {
    const catalog = new SessionCatalogService(sessions);
    cleanup.push(() => catalog.close());
    const live = new SessionLiveService(sessions, { interaction });
    cleanup.push(() => live.close());
    const operations = new OperationService(sessions, interaction, managers);
    cleanup.push(() => operations.close());
    return { sessions, managers, interaction, catalog, live, operations, close };
  } catch (error) {
    close();
    throw error;
  }
}

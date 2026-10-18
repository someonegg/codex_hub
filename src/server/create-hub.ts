import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import { createCodexSessionManager } from "./adapters/codex/session-manager.js";
import {
  SessionReadService,
  type SessionReadServiceDependencies,
} from "./application/session-read-service.js";
import { SessionCatalogService } from "./catalog/session-catalog-service.js";
import type { CodexHomeConfig } from "./config.js";
import { SessionInteractionService } from "./interaction/interaction-service.js";
import { livePaneBindings } from "./interaction/live-pane-binding-manager.js";
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
  const source = await createCodexSessionSource(codexHome, livePaneBindings);
  return createSessionReadService([source], {
    resolveNickname: (session) => source.nicknameFor(session),
    homes: [{ sourceInstanceId: source.descriptor.sourceInstanceId, nickname: "default" }],
  });
}

/** Compose reading and management using the adapter's published source identity. */
export async function createCodexHub(
  codexHome: string | readonly CodexHomeConfig[],
  socket?: string,
  interactionEnabled = true,
) {
  const homes =
    typeof codexHome === "string" ? [{ nickname: "default", path: codexHome }] : codexHome;
  const sources = await Promise.all(
    homes.map((home) => createCodexSessionSource(home.path, livePaneBindings)),
  );
  const sessions = createSessionReadService(sources, {
    resolveNickname: (session) =>
      sources
        .find((source) => source.descriptor.sourceInstanceId === session.origin.sourceInstanceId)
        ?.nicknameFor(session) ?? null,
    homes: sources.map((source, index) => ({
      sourceInstanceId: source.descriptor.sourceInstanceId,
      nickname: homes[index]!.nickname,
    })),
  });
  const managers = new SessionManagerRegistry(sources[0]!.descriptor.sourceInstanceId);
  sources.forEach((source, index) =>
    managers.register(
      source.descriptor.sourceInstanceId,
      createCodexSessionManager(homes[index]!.path, socket),
    ),
  );
  const transport = new TmuxInteractionService();
  const interaction = new SessionInteractionService(
    sessions,
    interactionEnabled,
    transport,
    livePaneBindings,
  );
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
    const operations = new OperationService(
      sessions,
      interaction,
      managers,
      undefined,
      undefined,
      livePaneBindings,
    );
    cleanup.push(() => operations.close());
    return { sessions, managers, interaction, catalog, live, operations, close };
  } catch (error) {
    close();
    throw error;
  }
}

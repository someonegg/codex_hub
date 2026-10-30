import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import { createCodexSessionManager } from "./adapters/codex/session-manager.js";
import {
  SessionReadService,
  type SessionReadServiceDependencies,
} from "./application/session-read-service.js";
import { SessionCatalogService } from "./catalog/session-catalog-service.js";
import type { CodexHomeConfig } from "./config.js";
import { SessionInteractionService } from "./interaction/interaction-service.js";
import { paneBindings } from "./interaction/pane-binding-manager.js";
import { SessionRuntime } from "./interaction/session-runtime.js";
import { TmuxInteractionService } from "./interaction/tmux-service.js";
import { OperationService } from "./management/operation-service.js";
import { SessionManagerRegistry } from "./management/session-manager.js";
import type { SessionSource } from "./source/session-source.js";
import { SessionUpdatesService } from "./updates/session-updates-service.js";
import type { UploadCleanup } from "./uploads/store.js";

function createSessionReadService(
  sources: readonly SessionSource[],
  dependencies?: SessionReadServiceDependencies,
): SessionReadService {
  return new SessionReadService(sources, undefined, undefined, dependencies);
}

export async function createCodexSessionReadService(
  codexHome: string,
): Promise<SessionReadService> {
  const source = await createCodexSessionSource(codexHome, paneBindings);
  return createSessionReadService([source], {
    resolveDisplayTitle: (session) => source.displayTitleFor(session),
    homes: [{ nickname: "default" }],
  });
}

/** Compose reading and management using the adapter's published Home nickname. */
export async function createCodexHub(
  homes: readonly CodexHomeConfig[],
  socket?: string,
  interactionEnabled = true,
  uploads?: UploadCleanup,
) {
  const sources = await Promise.all(
    homes.map((home) => createCodexSessionSource(home.path, paneBindings, home.nickname)),
  );
  const sessions = createSessionReadService(sources, {
    resolveDisplayTitle: (session) =>
      sources
        .find((source) => source.descriptor.home === session.origin.home)
        ?.displayTitleFor(session) ?? null,
    homes: sources.map((source) => ({ nickname: source.descriptor.home })),
  });
  const managers = new SessionManagerRegistry(sources[0]!.descriptor.home);
  sources.forEach((source, index) =>
    managers.register(
      source.descriptor.home,
      createCodexSessionManager(homes[index]!.path, socket),
    ),
  );
  const transport = new TmuxInteractionService();
  const interaction = new SessionInteractionService(
    sessions,
    interactionEnabled,
    transport,
    paneBindings,
  );
  const runtime = new SessionRuntime(transport, managers, paneBindings);
  sessions.runtime = runtime;
  interaction.runtime = runtime;
  const cleanup: (() => void)[] = [() => interaction.close()];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const release of cleanup) release();
  };
  try {
    const catalog = new SessionCatalogService(sessions);
    cleanup.push(() => catalog.close());
    const updates = new SessionUpdatesService(sessions, { interaction });
    cleanup.push(() => updates.close());
    const operations = new OperationService(
      sessions,
      interaction,
      managers,
      undefined,
      undefined,
      paneBindings,
      runtime,
      uploads,
    );
    cleanup.push(() => operations.close());
    return { sessions, managers, interaction, catalog, updates, operations, close };
  } catch (error) {
    close();
    throw error;
  }
}

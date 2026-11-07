import { createClaudeSessionSource } from "./adapters/claude/claude-session-source.js";
import { createClaudeSessionManager } from "./adapters/claude/session-manager.js";
import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import { createCodexSessionManager } from "./adapters/codex/session-manager.js";
import { CatalogInteractionSessionReader } from "./application/interaction-session-reader.js";
import { SessionReadService } from "./application/session-read-service.js";
import { SessionCatalogService } from "./catalog/session-catalog-service.js";
import type { AgentConfig } from "./config.js";
import { SessionInteractionService } from "./interaction/interaction-service.js";
import { PaneBindingManager } from "./interaction/pane-binding-manager.js";
import { SessionRuntime } from "./interaction/session-runtime.js";
import { TmuxInteractionService } from "./interaction/tmux-service.js";
import { OperationService } from "./management/operation-service.js";
import {
  managementCapabilities,
  type SessionManager,
  SessionManagerRegistry,
} from "./management/session-manager.js";
import { CatalogSnapshotStore } from "./repository/catalog-snapshot-store.js";
import type { SessionSource } from "./source/session-source.js";
import { SessionUpdatesService } from "./updates/session-updates-service.js";
import type { UploadCleanup } from "./uploads/store.js";

/** Compose reading and management using the adapter's published Agent nickname. */
export async function createAhub({
  agents,
  socket,
  claudeReadyScript,
  interactionEnabled = true,
  uploads,
}: {
  agents: readonly AgentConfig[];
  socket?: string;
  claudeReadyScript?: string;
  interactionEnabled?: boolean;
  uploads?: UploadCleanup;
}) {
  const paneBindings = new PaneBindingManager();
  const adapters = await Promise.all(
    agents.map((agent) => createAdapter(agent, socket, claudeReadyScript)),
  );
  const sources = adapters.map((adapter) => adapter.source);
  const managers = new SessionManagerRegistry(sources[0]!.descriptor.agent);
  for (const { source, manager } of adapters) managers.register(source.descriptor.agent, manager);
  const transport = new TmuxInteractionService();
  const runtime = new SessionRuntime(transport, managers, paneBindings);
  const store = new CatalogSnapshotStore(sources, undefined, undefined, {
    publishBindings: (events) => {
      for (const event of events) paneBindings.submit(event);
    },
  });
  const interaction = new SessionInteractionService(
    new CatalogInteractionSessionReader(store),
    transport,
    {
      enabled: interactionEnabled,
      bindings: paneBindings,
      runtime,
    },
  );
  const sessions = new SessionReadService(sources, {
    runtime,
    store,
    interaction,
    resolveDisplayTitle: (session) =>
      sources
        .find((source) => source.descriptor.agent === session.origin.agent)
        ?.displayTitleFor?.(session) ?? null,
    agents: sources.map((source) => ({
      nickname: source.descriptor.agent,
      runtimeName: source.descriptor.displayName,
      management: managementCapabilities(managers.get(source.descriptor.agent)),
    })),
  });
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
    const updates = new SessionUpdatesService(sessions);
    cleanup.push(() => updates.close());
    const operations = new OperationService(sessions, interaction, managers, {
      bindings: paneBindings,
      runtime,
      uploads,
    });
    cleanup.push(() => operations.close());
    return { sessions, managers, interaction, catalog, updates, operations, close };
  } catch (error) {
    close();
    throw error;
  }
}

interface SessionAdapter {
  readonly source: SessionSource;
  readonly manager: SessionManager;
}

async function createAdapter(
  agent: AgentConfig,
  socket?: string,
  claudeReadyScript?: string,
): Promise<SessionAdapter> {
  switch (agent.adapter ?? "codex") {
    case "claude":
      return {
        source: await createClaudeSessionSource(agent.path, { agent: agent.nickname }),
        manager: createClaudeSessionManager(agent.path, socket, claudeReadyScript),
      };
    case "codex":
      return {
        source: await createCodexSessionSource(agent.path, { agent: agent.nickname }),
        manager: createCodexSessionManager(agent.path, socket),
      };
  }
}

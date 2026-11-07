import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { paneBindings } from "../../src/server/interaction/pane-binding-manager.js";

export async function createCodexSessionReadService(
  codexAgent: string,
): Promise<SessionReadService> {
  const source = await createCodexSessionSource(codexAgent);
  return new SessionReadService([source], {
    publishBindings: (events) => {
      for (const event of events) paneBindings.submit(event);
    },
    resolveDisplayTitle: (session) => source.displayTitleFor(session),
    agents: [{ nickname: "default" }],
  });
}

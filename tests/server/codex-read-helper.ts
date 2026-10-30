import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { paneBindings } from "../../src/server/interaction/pane-binding-manager.js";

export async function createCodexSessionReadService(
  codexHome: string,
): Promise<SessionReadService> {
  const source = await createCodexSessionSource(codexHome, paneBindings);
  return new SessionReadService([source], {
    resolveDisplayTitle: (session) => source.displayTitleFor(session),
    homes: [{ nickname: "default" }],
  });
}

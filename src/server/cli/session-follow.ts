import type { SessionMessagesResponse } from "../../shared/api-contract.js";
import { CommandError } from "./command-error.js";
import { output } from "./output.js";
import { recoverMessageQuery, SessionClient } from "./session-client.js";
import { formatResult, mapInspect } from "./session-output.js";

/** Each round drains backlog before the next bounded tail wait. */
export async function followInspect(options: {
  path: string;
  query: URLSearchParams;
  base: URL;
  signal: AbortSignal;
  timeoutMs: number;
  count?: number;
  json: boolean;
}): Promise<void> {
  const { path, query, base, signal, timeoutMs, count, json } = options;
  let previousState: string | undefined;
  let emitted = false;
  let recovered = false;
  for (let round = 0; count === undefined || round < count; round++) {
    for (;;) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      let observed: SessionMessagesResponse | undefined;
      try {
        const client = new SessionClient(base, controller.signal);
        observed = await client.request<SessionMessagesResponse | undefined>(
          `${path}/messages?${query}`,
        );
      } catch (error) {
        if (!recovered && recoverMessageQuery(error, query)) {
          recovered = true;
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
      if (!observed) break;
      query.set("stateRevision", observed.stateRevision);
      const result = mapInspect(observed);
      const { updatedAt, ...sessionState } = result.session;
      const state = JSON.stringify([sessionState, result.interaction]);
      if (!emitted || result.items.length > 0 || previousState !== state) {
        const text = formatResult("inspect", result, { emptyItemsText: "No new messages." });
        output(result, json, (emitted ? "========================================\n" : "") + text);
        emitted = true;
      }
      previousState = state;
      const after = query.get("after");
      if (result.hasMore && result.nextAfter <= Number(after ?? 0))
        throw new CommandError("pagination_stalled", "Inspect pagination made no progress");
      query.set("after", String(result.nextAfter));
      if (!result.hasMore) {
        query.set("wait", "true");
        break;
      }
      query.delete("wait");
    }
  }
}

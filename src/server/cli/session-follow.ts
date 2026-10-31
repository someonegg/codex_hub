import type { SessionMessagesResponse } from "../../shared/api-contract.js";
import { CommandError } from "./command-error.js";
import { output } from "./output.js";
import { SessionClient } from "./session-client.js";
import { formatResult, mapInspect } from "./session-output.js";
import { pauseSessionPolling } from "./session-wait.js";

/** Sequential rounds drain all pages before starting the interval. */
export async function followInspect(options: {
  path: string;
  query: URLSearchParams;
  base: URL;
  signal: AbortSignal;
  timeoutMs: number;
  intervalMs: number;
  count?: number;
  json: boolean;
}): Promise<void> {
  const { path, query, base, signal, timeoutMs, intervalMs, count, json } = options;
  let previousState: string | undefined;
  let emitted = false;
  for (let round = 0; count === undefined || round < count; round++) {
    for (;;) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      let observed: SessionMessagesResponse;
      try {
        const client = new SessionClient(base, controller.signal);
        observed = await client.request<SessionMessagesResponse>(`${path}/messages?${query}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
      const result = mapInspect(observed);
      const state = JSON.stringify([result.session, result.interaction]);
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
      if (!result.hasMore) break;
    }
    if (count === undefined || round + 1 < count) {
      // Node timers cap long delays; split them while preserving cancellation.
      let remaining = intervalMs;
      while (remaining > 0) {
        const delay = Math.min(remaining, 2_147_483_647);
        await pauseSessionPolling(signal, delay);
        remaining -= delay;
      }
    }
  }
}

import type { HubOperation, InspectResponse } from "../../shared/api-contract.js";
import { CommandError } from "./command-error.js";
import type { SessionClient } from "./session-client.js";

const pauseSessionPolling = (signal: AbortSignal) =>
  new Promise<void>((accept, reject) => {
    if (signal.aborted) {
      reject(new Error("Command interrupted or timed out"));
      return;
    }
    const stop = () => {
      clearTimeout(wait);
      reject(new Error("Command interrupted or timed out"));
    };
    const wait = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      accept();
    }, 500);
    signal.addEventListener("abort", stop, { once: true });
  });

export async function waitForOperation(
  operation: HubOperation,
  api: SessionClient["request"],
  signal: AbortSignal,
): Promise<HubOperation> {
  while (operation.status === "pending") {
    await pauseSessionPolling(signal);
    operation = await api<HubOperation>(
      `/api/v1/operations/${encodeURIComponent(operation.operationId)}`,
    );
  }
  if (operation.status === "unknown")
    throw new CommandError(
      "operation_result_unknown",
      "Operation result unknown; check the current session state.",
      2,
    );
  if (operation.status !== "succeeded")
    throw new CommandError("operation_failed", "Operation failed; check the server diagnostics.");
  return operation;
}

export async function waitForLaunch(
  sessionId: string | null | undefined,
  api: SessionClient["request"],
  signal: AbortSignal,
): Promise<void> {
  if (!sessionId) throw new Error("Launch response has no session");
  for (;;) {
    const observed = await api<InspectResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/inspect?limit=1`,
    );
    if (
      observed.live &&
      observed.interaction.supported &&
      observed.interaction.state === "connected" &&
      observed.interaction.activity === "idle"
    )
      break;
    await pauseSessionPolling(signal);
  }
}

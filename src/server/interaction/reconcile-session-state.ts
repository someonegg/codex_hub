import type { InteractionResponse } from "../../shared/api-contract.js";
import type { SessionDetail } from "../../shared/domain.js";

/** Reconcile the read result with the later interaction observation. */
export function reconcileSessionState<
  T extends { readonly session: SessionDetail; readonly interaction: InteractionResponse },
>(value: T): T {
  if (value.session.status !== "archived" && value.interaction.supported) {
    const connected = value.interaction.state === "connected";
    value = {
      ...value,
      session: {
        ...value.session,
        status: connected ? "live" : "normal",
        resume:
          connected || value.interaction.state === "unknown"
            ? {
                allowed: false,
                reason: connected ? "Session is already live" : "Connection validation is unknown",
              }
            : value.session.resume,
      },
    };
  }
  return value;
}

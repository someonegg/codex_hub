import type { InteractionBindingAttempt } from "../domain/session-domain.js";
import type { PaneBindingManager } from "./pane-binding-manager.js";
import type { TmuxBinding } from "./transport.js";

/** One request's pane evidence, tied to the binding and ownership it observed. */
export type RuntimeObservation = {
  readonly sessionId: string;
  readonly attempt: InteractionBindingAttempt | null;
  readonly replacement: string | null;
} & (
  | { readonly state: "alive"; readonly target: TmuxBinding }
  | { readonly state: "unbound" | "invalid" | "unknown" | "exited"; readonly target: null }
);

export function isCurrentObservation(
  observation: RuntimeObservation,
  bindings: PaneBindingManager,
): boolean {
  return (
    observation.attempt === bindings.latest(observation.sessionId) &&
    observation.replacement === bindings.replacement(observation.sessionId)
  );
}

export async function observePaneBinding(
  sessionId: string,
  bindings: PaneBindingManager,
  probe: (
    attempt: InteractionBindingAttempt & { readonly valid: true },
  ) => Promise<TmuxBinding | null>,
): Promise<RuntimeObservation> {
  const attempt = bindings.latest(sessionId);
  const replacement = bindings.replacement(sessionId);
  const result = (state: Exclude<RuntimeObservation["state"], "alive">): RuntimeObservation => ({
    sessionId,
    attempt,
    replacement,
    state,
    target: null,
  });
  if (!attempt) return result("unbound");
  if (!attempt.valid) return result("invalid");
  try {
    const target = await probe(attempt);
    const observation: RuntimeObservation = target
      ? { sessionId, attempt, replacement, state: "alive", target }
      : result("exited");
    return isCurrentObservation(observation, bindings) ? observation : result("unknown");
  } catch {
    // A failed check is never evidence of pane death.
    return result("unknown");
  }
}

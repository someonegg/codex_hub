import type { ResumeCapability, SessionStatus } from "../../shared/domain.js";
import type { DomainSession, InteractionBindingAttempt } from "../domain/session-domain.js";
import type { RuntimeObservation } from "./pane-observation.js";
import type { TmuxBinding } from "./transport.js";

export interface RuntimeEvaluator {
  evaluate(
    session: DomainSession,
    detail?: boolean,
    observation?: RuntimeObservation,
  ): Promise<{
    status: SessionStatus;
    resume: ResumeCapability;
    directory?: string;
  }>;
}
export interface RuntimeReader extends RuntimeEvaluator {
  observe(sessionId: string): Promise<RuntimeObservation>;
}
export interface RuntimeProbe {
  probe(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null>;
}

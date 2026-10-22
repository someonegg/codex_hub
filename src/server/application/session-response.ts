import type { InteractionResponse } from "../../shared/api-contract.js";
import type { SessionDetail } from "../../shared/domain.js";
import { reconcileSessionState } from "../interaction/reconcile-session-state.js";
import { type UpdateRevisionFactory, withUpdateRevision } from "../updates/update-revision.js";
import type { InteractionSessionSnapshot } from "./session-reader.js";

export interface SessionInteractionReader {
  describeSnapshot(
    sessionId: string,
    snapshot: InteractionSessionSnapshot,
  ): Promise<InteractionResponse>;
}

/** Assemble public reader state from one source snapshot and its runtime observation. */
export async function assembleSessionResponse<
  T extends {
    readonly session: SessionDetail;
    readonly interactionSession: InteractionSessionSnapshot;
  },
>(input: T, interaction: SessionInteractionReader | undefined, revision: UpdateRevisionFactory) {
  const { interactionSession, ...response } = input;
  const description = interaction
    ? await interaction.describeSnapshot(input.session.id, interactionSession)
    : { supported: false as const, attachCommand: null };
  return withUpdateRevision(
    reconcileSessionState({ ...response, interaction: description }),
    revision,
  );
}

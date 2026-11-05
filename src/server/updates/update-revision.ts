import { createHash } from "node:crypto";

import type {
  InteractionResponse,
  SessionMessagesResponse,
  UpdateRevision,
} from "../../shared/api-contract.js";
import type { SessionDetail } from "../../shared/domain.js";

export type UpdateRevisionFactory = (
  session: UpdateRevisionSession,
  interaction: InteractionResponse,
) => UpdateRevision;

export type UpdateRevisionSession = SessionDetail;

export const createUpdateRevision: UpdateRevisionFactory = (
  { updatedAt, ...session },
  interaction,
) =>
  createHash("sha256")
    .update(canonicalJson({ session, interaction }))
    .digest("base64url") as UpdateRevision;

export function withUpdateRevision<
  T extends {
    readonly session: SessionDetail;
    readonly interaction: InteractionResponse;
  },
>(
  value: T,
  createRevision: UpdateRevisionFactory,
): T & Pick<SessionMessagesResponse, "stateRevision"> {
  return {
    ...value,
    stateRevision: createRevision(value.session, value.interaction),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

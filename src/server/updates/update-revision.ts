import { createHmac, randomBytes } from "node:crypto";

import type {
  InteractionResponse,
  SessionUpdatesResponse,
  UpdateRevision,
} from "../../shared/api-contract.js";
import type { SessionDetail } from "../../shared/domain.js";

export type UpdateRevisionFactory = (
  session: UpdateRevisionSession,
  interaction: InteractionResponse,
) => UpdateRevision;

export type UpdateRevisionSession = Omit<SessionDetail, "nickname">;

export function createProcessUpdateRevisionFactory(
  secret: Uint8Array = randomBytes(32),
): UpdateRevisionFactory {
  return (session, interaction) =>
    createHmac("sha256", secret)
      .update(canonicalJson({ session, interaction }))
      .digest("base64url") as UpdateRevision;
}

export function withUpdateRevision<
  T extends {
    readonly session: SessionDetail;
    readonly interaction: InteractionResponse;
  },
>(
  value: T,
  createRevision: UpdateRevisionFactory,
): T & Pick<SessionUpdatesResponse, "updateRevision"> {
  const { nickname: _nickname, ...revisionSession } = value.session;
  return {
    ...value,
    updateRevision: createRevision(revisionSession, value.interaction),
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

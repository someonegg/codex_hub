import { resolve } from "node:path";

import {
  IdentityResolver,
  type SessionMetadata,
} from "../../src/server/adapters/codex/identity-resolver.js";
import type { RolloutDescriptor } from "../../src/server/adapters/codex/rollout-descriptor.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import {
  CheckpointedJsonlDecoder,
  type DecodedRecord,
} from "../../src/server/adapters/shared/jsonl-decoder.js";
import type { DomainDiagnostic } from "../../src/server/domain/session-domain.js";
import { rolloutDescriptor } from "../helpers/rollout-descriptor.js";

const fixtureAgent = resolve("tests/fixtures/codex-home");

export async function normalizeFixture(fileName: string) {
  const descriptor = await rolloutDescriptor(
    fixtureAgent,
    resolve(fixtureAgent, "sessions/2026/07/28", fileName),
  );
  if (descriptor === null) throw new Error(`Fixture rollout was not discovered: ${fileName}`);
  const decoded = { ...(await new CheckpointedJsonlDecoder().decode(descriptor)), descriptor };
  const metadata = resolveIdentity(decoded);
  return normalizeDecoded(decoded, metadata);
}

export function normalizeRecords(
  id: string,
  records: DecodedRecord[],
  metadata: Partial<SessionMetadata> = {},
) {
  return normalizeDecoded(decodedRollout(id, records), sessionMetadata(metadata));
}

export function decodedRollout(id: string, records: DecodedRecord[]): DecodedRollout {
  return {
    descriptor: {
      id,
      path: `/synthetic/rollout-${id}.jsonl`,
      sourceRelativePath: `sessions/rollout-${id}.jsonl`,
      archived: false,
      size: 1,
      mtimeMs: 1,
    },
    diagnostics: [],
    records,
  };
}

export function sessionMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    threadId: null,
    runtimeVersion: null,
    title: null,
    workingDirectory: null,
    projectDirectory: null,
    createdAt: null,
    updatedAt: null,
    parentThreadId: null,
    archived: false,
    ...overrides,
  };
}

export interface DecodedRollout {
  descriptor: RolloutDescriptor;
  records: DecodedRecord[];
  diagnostics: DomainDiagnostic[];
}
export function resolveIdentity(decoded: DecodedRollout) {
  const resolver = new IdentityResolver();
  return resolver.metadata(resolver.append(resolver.create(decoded.descriptor), decoded.records));
}
export function normalizeDecoded(decoded: DecodedRollout, metadata: SessionMetadata) {
  const normalizer = new DefaultSessionNormalizer();
  return normalizer.materialize(
    normalizer.append(normalizer.create(decoded.descriptor), decoded.records, decoded.diagnostics),
    metadata,
  );
}

import { resolve } from "node:path";

import {
  IdentityResolver,
  type SessionMetadata,
} from "../../src/server/adapters/codex/identity-resolver.js";
import {
  CheckpointedRolloutDecoder,
  type DecodedRecord,
  type DecodedRollout,
} from "../../src/server/adapters/codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import { rolloutDescriptor } from "../helpers/rollout-descriptor.js";

const fixtureHome = resolve("tests/fixtures/codex-home");

export async function normalizeFixture(fileName: string) {
  const descriptor = await rolloutDescriptor(
    fixtureHome,
    resolve(fixtureHome, "sessions/2026/07/28", fileName),
  );
  if (descriptor === null) throw new Error(`Fixture rollout was not discovered: ${fileName}`);
  const decoded = await new CheckpointedRolloutDecoder().decode(descriptor);
  const metadata = new IdentityResolver().resolve(decoded);
  return new DefaultSessionNormalizer().normalize(decoded, metadata);
}

export function normalizeRecords(
  id: string,
  records: DecodedRecord[],
  metadata: Partial<SessionMetadata> = {},
) {
  return new DefaultSessionNormalizer().normalize(
    decodedRollout(id, records),
    sessionMetadata(metadata),
  );
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
    agentVersion: null,
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

import { basename } from "node:path";

import type { DomainAgentIdentity as AgentIdentity } from "../../domain/session-domain.js";
import { nonEmptyAgentIdentity, taskNameFromAgentPath } from "./agent-identity.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";

export interface SessionMetadata {
  threadId: string | null;
  agentVersion: string | null;
  title: string | null;
  workingDirectory: string | null;
  projectDirectory: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  parentThreadId: string | null;
  archived: boolean;
  agent?: AgentIdentity | null;
}

interface RawMetadata {
  id: string | null;
  agentVersion: string | null;
  title: string | null;
  cwd: string | null;
  timestamp: string | null;
  parentThreadId: string | null;
  agent: AgentIdentity | null;
}

export interface IdentityAccumulatorState {
  readonly fileName: string;
  readonly archived: boolean;
  readonly firstMetadata: RawMetadata | null;
  readonly firstMatchingMetadata: RawMetadata | null;
  readonly hasFirstRecord: boolean;
  readonly firstRecordTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

export class IdentityResolver {
  create(descriptor: RolloutDescriptor): IdentityAccumulatorState {
    return {
      fileName: basename(descriptor.path),
      archived: descriptor.archived,
      firstMetadata: null,
      firstMatchingMetadata: null,
      hasFirstRecord: false,
      firstRecordTimestamp: null,
      lastTimestamp: null,
    };
  }

  append(
    state: IdentityAccumulatorState,
    records: readonly DecodedRecord[],
  ): IdentityAccumulatorState {
    if (records.length === 0) return state;
    let firstMetadata = state.firstMetadata;
    let firstMatchingMetadata = state.firstMatchingMetadata;
    let hasFirstRecord = state.hasFirstRecord;
    let firstRecordTimestamp = state.firstRecordTimestamp;
    let lastTimestamp = state.lastTimestamp;

    for (const record of records) {
      const timestamp = timestampOf(record.value);
      if (!hasFirstRecord) {
        hasFirstRecord = true;
        firstRecordTimestamp = timestamp;
      }
      if (timestamp !== null) lastTimestamp = timestamp;
      if (record.value.type !== "session_meta") continue;
      const metadata = rawMetadata(record.value.payload);
      if (metadata === null) continue;
      firstMetadata ??= metadata;
      if (
        firstMatchingMetadata === null &&
        metadata.id !== null &&
        state.fileName.includes(metadata.id)
      )
        firstMatchingMetadata = metadata;
    }

    return {
      ...state,
      firstMetadata,
      firstMatchingMetadata,
      hasFirstRecord,
      firstRecordTimestamp,
      lastTimestamp,
    };
  }

  metadata(state: IdentityAccumulatorState): SessionMetadata {
    const raw = state.firstMatchingMetadata ?? state.firstMetadata;
    return {
      threadId: raw?.id ?? null,
      agentVersion: raw?.agentVersion ?? null,
      title: raw?.title ?? null,
      workingDirectory: raw?.cwd ?? null,
      projectDirectory: raw?.cwd ?? null,
      createdAt: raw?.timestamp ?? state.firstRecordTimestamp,
      updatedAt: state.lastTimestamp,
      parentThreadId: raw?.parentThreadId ?? null,
      archived: state.archived,
      agent: raw?.agent ?? null,
    };
  }

  resolve(decoded: DecodedRollout): SessionMetadata {
    return this.metadata(this.append(this.create(decoded.descriptor), decoded.records));
  }
}

function rawMetadata(value: unknown): RawMetadata | null {
  if (!isObject(value)) return null;
  const spawn = threadSpawn(value);
  return {
    id: string(value.id),
    agentVersion: string(value.cli_version ?? value.agent_version),
    title: string(value.title),
    cwd: string(value.cwd),
    timestamp: string(value.timestamp),
    parentThreadId:
      string(value.parent_thread_id) ?? string(value.parent_id) ?? string(spawn?.parent_thread_id),
    agent: rawAgent(value, spawn),
  };
}

function threadSpawn(value: Record<string, unknown>): Record<string, unknown> | null {
  const source = isObject(value.source) ? value.source : null;
  const subagent = source?.subagent;
  return isObject(subagent) && isObject(subagent.thread_spawn) ? subagent.thread_spawn : null;
}

function rawAgent(
  value: Record<string, unknown>,
  spawn: Record<string, unknown> | null,
): AgentIdentity | null {
  const source = isObject(value.source) ? value.source : null;
  const subagent = source?.subagent;
  return nonEmptyAgentIdentity({
    taskName: taskNameFromAgentPath(string(value.agent_path) ?? string(spawn?.agent_path)),
    nickname: string(value.agent_nickname) ?? string(spawn?.agent_nickname),
    role:
      string(value.agent_role) ??
      string(spawn?.agent_role) ??
      (typeof subagent === "string" ? subagent : null),
  });
}

function timestampOf(record: Record<string, unknown> | undefined): string | null {
  return record === undefined ? null : string(record.timestamp);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

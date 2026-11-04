import type {
  DomainDiagnostic,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../domain/session-domain.js";
import { normalizeSessionTitle, sessionTitleFromMarkdown } from "../../domain/session-text.js";
import type { SessionMetadata } from "./identity-resolver.js";
import { codexInteraction } from "./interaction-parser.js";
import { MAX_SESSION_DIAGNOSTICS } from "./limits.js";
import { eventMessage } from "./message-normalizer.js";
import { type ParsedResponseItem, parseResponseItem } from "./response-item-parser.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";
import {
  type NormalizedUserInput,
  normalizeUserInputRequest,
  normalizeUserInputResponse,
  type UserInputRequest,
} from "./user-input-normalizer.js";
import { nonEmptyString } from "./value-readers.js";

export interface SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerState;
  append(
    state: SessionNormalizerState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerState;
  materialize(
    state: SessionNormalizerState,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
}

export interface SessionNormalizerState {
  readonly descriptor: RolloutDescriptor;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly pendingUserInputRequests: ReadonlyMap<string, UserInputRequest>;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly normalizerDiagnostics: readonly DomainDiagnostic[];
  readonly hasFirstUserMessage: boolean;
  readonly firstUserTitle: string | null;
}

export class DefaultSessionNormalizer implements SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerState {
    return {
      descriptor,
      timeline: [],
      pendingUserInputRequests: new Map(),
      decoderDiagnostics: [],
      normalizerDiagnostics: [],
      hasFirstUserMessage: false,
      firstUserTitle: null,
    };
  }

  append(
    state: SessionNormalizerState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerState {
    const nextDecoderDiagnostics = decoderDiagnostics.slice(0, MAX_SESSION_DIAGNOSTICS);
    const decoderDiagnosticsUnchanged = sameDiagnostics(
      state.decoderDiagnostics,
      nextDecoderDiagnostics,
    );
    if (records.length === 0 && decoderDiagnosticsUnchanged) {
      return state;
    }

    const items: DomainTimelineRecord[] = [];
    const pendingUserInputRequests = new LazyMap(state.pendingUserInputRequests);
    const normalizerDiagnostics = [...state.normalizerDiagnostics];
    for (const record of records) {
      consumeRecord(record, items, pendingUserInputRequests, normalizerDiagnostics);
    }

    let hasFirstUserMessage = state.hasFirstUserMessage;
    let firstTitle = state.firstUserTitle;
    for (const item of items) {
      if (!hasFirstUserMessage && item.kind === "message" && item.role === "user") {
        hasFirstUserMessage = true;
        firstTitle = sessionTitleFromMarkdown(item.markdown);
      }
    }

    return {
      ...state,
      timeline: items.length === 0 ? state.timeline : [...state.timeline, ...items],
      pendingUserInputRequests: pendingUserInputRequests.result,
      decoderDiagnostics: decoderDiagnosticsUnchanged
        ? state.decoderDiagnostics
        : nextDecoderDiagnostics,
      normalizerDiagnostics,
      hasFirstUserMessage,
      firstUserTitle: firstTitle,
    };
  }

  materialize(
    state: SessionNormalizerState,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const diagnostics = combinedDiagnostics(state);
    const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length;
    const title =
      normalizeSessionTitle(metadata.title) ?? state.firstUserTitle ?? "Untitled session";
    const session: DomainSession = {
      id: state.descriptor.id,
      sourceId: metadata.threadId,
      origin,
      title,
      workingDirectory: metadata.workingDirectory,
      projectDirectory: metadata.projectDirectory,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      parentId: metadata.parentThreadId,
      childIds: [],
      agent: metadata.agent ?? null,
      warningCount,
      diagnostics,
    };
    return {
      session,
      timeline: state.timeline,
      interaction: codexInteraction(),
    };
  }

  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const state = this.append(
      this.create(decoded.descriptor),
      decoded.records,
      decoded.diagnostics,
    );
    return this.materialize(state, metadata, origin);
  }
}

function combinedDiagnostics(state: SessionNormalizerState): readonly DomainDiagnostic[] {
  const remaining = MAX_SESSION_DIAGNOSTICS - state.decoderDiagnostics.length;
  return [...state.decoderDiagnostics, ...state.normalizerDiagnostics.slice(0, remaining)];
}

function sameDiagnostics(
  left: readonly DomainDiagnostic[],
  right: readonly DomainDiagnostic[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        item.code === candidate.code &&
        item.severity === candidate.severity &&
        item.message === candidate.message &&
        item.ordinal === candidate.ordinal
      );
    })
  );
}

interface MapOperations<K, V> {
  set(key: K, value: V): void;
  delete(key: K): boolean;
}

class LazyMap<K, V> implements MapOperations<K, V> {
  #copy?: Map<K, V>;
  constructor(private readonly original: ReadonlyMap<K, V>) {}
  get result(): ReadonlyMap<K, V> {
    return this.#copy ?? this.original;
  }
  set(key: K, value: V): void {
    if (this.result.has(key) && this.result.get(key) === value) return;
    (this.#copy ??= new Map(this.original)).set(key, value);
  }
  delete(key: K): boolean {
    if (!this.result.has(key)) return false;
    return (this.#copy ??= new Map(this.original)).delete(key);
  }
}

const DEFAULT_SESSION_ORIGIN: DomainSessionOrigin = {
  sourceType: "test",
  home: "test",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
};

function consumeRecord(
  record: DecodedRecord,
  items: DomainTimelineRecord[],
  pendingUserInputRequests: MapOperations<string, UserInputRequest>,
  diagnostics: DomainDiagnostic[],
): void {
  const timestamp = nonEmptyString(record.value.timestamp);
  const payload = record.value.payload;
  if (!isObject(payload)) {
    if (typeof record.value.type !== "string")
      appendDiagnostic(diagnostics, {
        code: "unknown_record",
        severity: "info",
        message: "A record without a recognized type was reduced to a safe diagnostic.",
        ordinal: record.ordinal,
      });
    return;
  }
  if (record.value.type === "response_item") {
    consumeParsedResponse(
      parseResponseItem(record.ordinal, timestamp, payload),
      items,
      pendingUserInputRequests,
      diagnostics,
    );
  } else if (record.value.type === "event_msg") {
    const message = eventMessage(record.ordinal, timestamp, payload);
    if (message) items.push(message);
  }
}

function appendDiagnostic(diagnostics: DomainDiagnostic[], diagnostic: DomainDiagnostic): void {
  if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

function consumeParsedResponse(
  parsed: ParsedResponseItem,
  items: DomainTimelineRecord[],
  pendingUserInputRequests: MapOperations<string, UserInputRequest>,
  diagnostics: DomainDiagnostic[],
): void {
  switch (parsed.kind) {
    case "tool_output": {
      if (pendingUserInputRequests.delete(parsed.value.callId)) {
        addUserInput(normalizeUserInputResponse(parsed.value), items, diagnostics);
      }
      break;
    }
    case "user_input_request":
      pendingUserInputRequests.set(parsed.value.callId, parsed.value);
      addUserInput(normalizeUserInputRequest(parsed.value), items, diagnostics);
      break;
    case "ignored":
      break;
  }
}

function addUserInput(
  accumulated: NormalizedUserInput,
  items: DomainTimelineRecord[],
  diagnostics: DomainDiagnostic[],
): void {
  items.push(accumulated.item);
  if (accumulated.malformed) {
    appendDiagnostic(diagnostics, {
      code: "invalid_user_input",
      severity: "warning",
      message: "A request_user_input call or output had an unsupported payload shape.",
      ordinal: accumulated.item.ordinal,
    });
  }
}

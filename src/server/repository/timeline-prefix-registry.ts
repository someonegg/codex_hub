import { randomBytes } from "node:crypto";

import type { DomainSessionId, NormalizedSession } from "../domain/session-domain.js";
import {
  deriveTimelinePrefixIndex,
  extendsTimelinePrefix,
  extendTimelinePrefixIndex,
  type TimelinePrefixIndex,
} from "./timeline-prefix-index.js";

export interface IndexedSession {
  readonly normalized: NormalizedSession;
  readonly timelinePrefixIndex: TimelinePrefixIndex;
}

export interface PreparedTimelinePrefixes {
  readonly sessions: ReadonlyMap<DomainSessionId, IndexedSession>;
  commit(): void;
}

export type TimelinePrefixIndexBuilder = (
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
  /** Previous published state is a candidate; the builder must validate continuity. */
  previous?: IndexedSession,
) => TimelinePrefixIndex;

function buildTimelinePrefixIndex(
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
  previous?: IndexedSession,
): TimelinePrefixIndex {
  return previous !== undefined &&
    extendsTimelinePrefix(previous.normalized, normalized) &&
    previous.normalized.timeline.length < normalized.timeline.length
    ? extendTimelinePrefixIndex(
        previous.timelinePrefixIndex,
        previous.normalized,
        normalized,
        prefixKey,
        true,
      )
    : deriveTimelinePrefixIndex(normalized, prefixKey);
}

export class TimelinePrefixRegistry {
  #published = new Map<DomainSessionId, IndexedSession>();
  #generation = 0n;

  constructor(
    private readonly buildIndex: TimelinePrefixIndexBuilder = buildTimelinePrefixIndex,
    private readonly prefixKey: Uint8Array = randomBytes(32),
  ) {}

  prepare(
    sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
    dirtyIds?: ReadonlySet<DomainSessionId>,
  ): PreparedTimelinePrefixes {
    const baseGeneration = this.#generation;
    const next = new Map<DomainSessionId, IndexedSession>();
    for (const [id, normalized] of sessions) {
      const previous = this.#published.get(id);
      if (previous !== undefined && dirtyIds !== undefined && !dirtyIds.has(id)) {
        next.set(id, previous);
        continue;
      }
      const unchangedPrefix =
        previous !== undefined &&
        previous.normalized.timeline.length === normalized.timeline.length &&
        extendsTimelinePrefix(previous.normalized, normalized);
      const published = {
        normalized,
        timelinePrefixIndex: unchangedPrefix
          ? previous.timelinePrefixIndex
          : this.buildIndex(normalized, this.prefixKey, previous),
      };
      next.set(id, published);
    }
    let committed = false;
    return {
      sessions: next,
      commit: () => {
        if (committed) return;
        if (this.#generation !== baseGeneration) {
          throw new Error("Cannot commit stale prepared timeline prefixes");
        }
        this.#published = next;
        this.#generation += 1n;
        committed = true;
      },
    };
  }
}

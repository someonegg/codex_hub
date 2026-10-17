import { describe, expect, it } from "vitest";

import { OpaqueCursorCodec } from "../../src/server/repository/opaque-cursor.js";
import type { TimelineCursor } from "../../src/shared/api-contract.js";

describe("OpaqueCursorCodec", () => {
  it("classifies a timeline cursor signed by another instance as untrusted", () => {
    const first = new OpaqueCursorCodec(Buffer.alloc(32, 3));
    const restarted = new OpaqueCursorCodec(Buffer.alloc(32, 4));
    const cursor = first.encodeTimeline("session-id", 7, "prefix-token");

    expect(first.decodeTimeline(cursor)).toMatchObject({
      kind: "valid",
      value: { s: "session-id", o: 7, p: "prefix-token" },
    });
    expect(restarted.decodeTimeline(cursor)).toEqual({ kind: "untrusted" });
    expect(first.decodeTimeline("e30.invalid" as TimelineCursor)).toEqual({ kind: "malformed" });
  });
});

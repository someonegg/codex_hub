import { describe, expect, it } from "vitest";

import { encodeStringTuple, opaqueIdForParts } from "../../src/server/security/opaque-id.js";

describe("opaque IDs", () => {
  it("unambiguously encodes tuple parts containing NUL", () => {
    const left = ["source", "local\0duplicate"];
    const right = ["source\0local", "duplicate"];

    expect(encodeStringTuple(...left)).not.toBe(encodeStringTuple(...right));
    expect(opaqueIdForParts(...left)).not.toBe(opaqueIdForParts(...right));
  });

  it("preserves distinctions between arbitrary JavaScript strings", () => {
    expect(opaqueIdForParts("\ud800")).not.toBe(opaqueIdForParts("\ufffd"));
  });
});

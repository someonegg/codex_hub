import { describe, expect, it } from "vitest";

import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import type { DomainDiagnostic as Diagnostic } from "../../src/server/domain/session-domain.js";
import { decodedRollout, sessionMetadata } from "./session-normalizer.fixtures.js";

describe("session normalizer diagnostics", () => {
  it("does not append unknown-record diagnostics after the decoder reaches the limit", () => {
    const decoded = decodedRollout("full-diagnostics", [
      {
        ordinal: 51,
        value: {},
      },
    ]);
    decoded.diagnostics = diagnostics(50);

    const normalized = new DefaultSessionNormalizer().normalize(decoded, sessionMetadata());

    expect(normalized.session.diagnostics).toEqual(decoded.diagnostics);
    expect(normalized.session.warningCount).toBe(50);
    expect(normalized.session.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "unknown_record" }),
    );
  });

  it("keeps only the first 50 diagnostics from a custom decoder", () => {
    const decoded = decodedRollout("custom-decoder-diagnostics", []);
    decoded.diagnostics = diagnostics(60);

    const normalized = new DefaultSessionNormalizer().normalize(decoded, sessionMetadata());

    expect(normalized.session.diagnostics).toEqual(decoded.diagnostics.slice(0, 50));
    expect(normalized.session.warningCount).toBe(50);
  });
});

function diagnostics(count: number): Diagnostic[] {
  return Array.from({ length: count }, (_, index) => ({
    code: `decoder_warning_${index + 1}`,
    severity: "warning",
    message: `Decoder warning ${index + 1}`,
    ordinal: index + 1,
  }));
}

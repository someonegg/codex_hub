import { describe, expect, it } from "vitest";

import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import type { DomainDiagnostic as Diagnostic } from "../../src/server/domain/session-domain.js";
import { decodedRollout, sessionMetadata } from "./session-normalizer.fixtures.js";

describe("session normalizer diagnostics", () => {
  it("caps custom decoder diagnostics before adding unknown-record warnings", () => {
    const decoded = decodedRollout("custom-decoder-diagnostics", [{ ordinal: 61, value: {} }]);
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

import { expect, it } from "vitest";

import { CommandError, commandFailure, httpFailure } from "../../src/server/cli/command-error.js";

it.each([
  ["GET", false, 504, "operation_result_unknown", 1],
  ["GET", true, 404, "session_not_found", 2],
  ["POST", true, 504, "operation_result_unknown", 2],
  ["POST", true, 502, "interaction_failed", 1],
] as const)(
  "maps %s errors with submitted=%s, status=%s and code=%s",
  (method, submitted, status, code, exitCode) => {
    const error = httpFailure(status, method, { code, message: "backend failure" }, submitted);
    expect(error.exitCode).toBe(exitCode);
    expect(error.code).toBe(exitCode === 2 ? "operation_result_unknown" : "request_failed");
    if (exitCode === 1) expect(error.message).toBe("backend failure");
  },
);

it("preserves classified failures and classifies transport failures by submitted writes", () => {
  const classified = new CommandError("operation_failed", "failed");
  expect(commandFailure(classified, true)).toBe(classified);
  expect(commandFailure(new Error("connection lost"), false)).toMatchObject({
    code: "query_failed",
    exitCode: 1,
    message: "Query failed: connection lost",
  });
  expect(commandFailure(new Error("connection lost"), true)).toMatchObject({
    code: "operation_result_unknown",
    exitCode: 2,
  });
  expect(httpFailure(404, "GET", undefined, false).message).toBe("HTTP 404");
});

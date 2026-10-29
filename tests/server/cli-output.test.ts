import { afterEach, expect, it, vi } from "vitest";
import { output, outputFailure, singleLine } from "../../src/server/cli/output.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
it("keeps JSON results compatible and human output explicit", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  output({ deleted: true }, true, "Deleted page id");
  expect(log).toHaveBeenLastCalledWith('{"deleted":true}');
  output({ deleted: true }, false, "Deleted page id");
  expect(log).toHaveBeenLastCalledWith("Deleted page id");
  expect(singleLine("a\nb\tc")).toBe("a b c");
});
it("separates JSON errors from human diagnostics", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  outputFailure(new Error("Storage failed"), true);
  expect(JSON.parse(log.mock.calls[0]![0]).error.code).toBe("command_failed");
  expect(err).not.toHaveBeenCalled();
  outputFailure(new Error("Storage failed"), false);
  expect(err).toHaveBeenCalledWith("Storage failed");
  expect(process.exitCode).toBe(1);
});

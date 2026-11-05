import { expect, it } from "vitest";

import { exitSteps, interruptSteps } from "../../src/server/adapters/shared/session-management.js";

it("interrupts with Ctrl+U then Escape after the configured delay", () => {
  expect(interruptSteps()).toEqual([
    { keys: ["C-u"], delayMs: 0 },
    { keys: ["Escape"], delayMs: 100 },
  ]);
});

it("requests exit with three Ctrl+C steps at the configured delays", () => {
  expect(exitSteps()).toEqual([
    { keys: ["C-c"], delayMs: 0 },
    { keys: ["C-c"], delayMs: 1000 },
    { keys: ["C-c"], delayMs: 1000 },
  ]);
});

import { expect, it } from "vitest";

import { cleanupAfterEach, runCleanups } from "../helpers/cleanup.js";

it("awaits every cleanup in reverse order and reports all failures without retrying resources", async () => {
  const events: string[] = [];
  const syncError = new Error("sync cleanup failed");
  const asyncError = new Error("async cleanup failed");
  cleanupAfterEach(() => {
    events.push("first");
  });
  cleanupAfterEach(async () => {
    events.push("second start");
    await Promise.resolve();
    events.push("second end");
    throw asyncError;
  });
  cleanupAfterEach(() => {
    events.push("third");
    throw syncError;
  });

  await expect(runCleanups()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [syncError, asyncError],
  });
  expect(events).toEqual(["third", "second start", "second end", "first"]);
  await expect(runCleanups()).resolves.toBeUndefined();
  expect(events).toHaveLength(4);
});

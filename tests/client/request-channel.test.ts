import { expect, it } from "vitest";

import { createRequestChannel } from "../../src/client/state/request-channel";

it("invalidates old tickets even when the transport ignores cancellation", () => {
  const channel = createRequestChannel();
  const old = channel.begin();
  const fresh = channel.begin();
  expect(old.signal.aborted).toBe(true);
  expect(old.isCurrent()).toBe(false);
  expect(fresh.isCurrent()).toBe(true);
  channel.cancel();
  expect(fresh.isCurrent()).toBe(false);
});

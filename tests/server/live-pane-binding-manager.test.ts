import { describe, expect, it } from "vitest";

import {
  type LivePaneBindEvent,
  LivePaneBindingManager,
} from "../../src/server/interaction/live-pane-binding-manager.js";

function bind(sessionId: string, time: number, paneId: string, ordinal = time): LivePaneBindEvent {
  return {
    sessionId,
    time,
    ordinal,
    position: 0,
    attempt: { valid: true, ordinal, socketPath: "/tmp/shared.sock", paneId },
  };
}

function permutations<T>(items: T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
      );
}

describe("LivePaneBindingManager", () => {
  it("keeps independent pane claims regardless of event order, batch boundaries or duplicate scans", () => {
    const events = [bind("A", 1, "%1"), bind("B", 1, "%2"), bind("C", 2, "%1"), bind("C", 3, "%2")];
    for (const order of permutations(events)) {
      const manager = new LivePaneBindingManager();
      for (const event of order) manager.submit(event);
      expect(manager.replacement("A")).toBe("C");
      expect(manager.replacement("B")).toBe("C");
      expect(manager.owns("C", { socketPath: "/tmp/shared.sock", paneId: "%2" })).toBe(true);
      for (const event of [...order].reverse()) manager.submit({ ...event });
      expect(manager.latest("C")).toEqual(events[3]!.attempt);
      expect(manager.replacement("A")).toBe("C");
      expect(manager.replacement("B")).toBe("C");
    }
  });

  it("lets an older session event independently replace a newer-than-pane event", () => {
    const manager = new LivePaneBindingManager();
    manager.submit(bind("C", 30, "%2"));
    manager.submit(bind("A", 10, "%1"));
    manager.submit(bind("C", 20, "%1"));
    expect(manager.replacement("A")).toBe("C");
    expect(manager.latest("C")).toMatchObject({ paneId: "%2" });
  });

  it("requires a new bind to refresh a superseded session and retains claims after an invalid bind", () => {
    const manager = new LivePaneBindingManager();
    const original = bind("A", 1, "%1");
    manager.submit(original);
    manager.submit(bind("C", 2, "%1"));
    manager.submit({
      sessionId: "C",
      time: 3,
      ordinal: 3,
      position: 0,
      attempt: { valid: false, ordinal: 3 },
    });
    manager.submit(original);
    expect(manager.replacement("A")).toBe("C");
    expect(manager.latest("C")).toEqual({ valid: false, ordinal: 3 });
    manager.submit(bind("A", 4, "%1"));
    expect(manager.replacement("A")).toBeNull();
    expect(manager.owns("A", { socketPath: "/tmp/shared.sock", paneId: "%1" })).toBe(true);
  });

  it("breaks equal timestamps by stable session ID, record ordinal and bind position", () => {
    const events = [
      bind("A", 1, "%1"),
      bind("Z", 1, "%1"),
      bind("Z", 1, "%2", 2),
      { ...bind("Z", 1, "%3", 2), position: 1 },
    ];
    for (const order of permutations(events)) {
      const manager = new LivePaneBindingManager();
      order.forEach((event) => manager.submit(event));
      expect(manager.replacement("A")).toBe("Z");
      expect(manager.latest("Z")).toMatchObject({ paneId: "%3" });
    }
  });

  it("distinguishes socket paths and instance-namespaced sessions", () => {
    const manager = new LivePaneBindingManager();
    manager.submit(bind("instance-a/session", 1, "%1"));
    manager.submit({
      ...bind("instance-b/session", 2, "%1"),
      attempt: { valid: true, ordinal: 2, socketPath: "/tmp/other.sock", paneId: "%1" },
    });
    expect(manager.replacement("instance-a/session")).toBeNull();
    manager.submit(bind("instance-b/session", 3, "%1"));
    expect(manager.replacement("instance-a/session")).toBe("instance-b/session");
  });
});

import { describe, expect, it } from "vitest";

import {
  type PaneBindEvent,
  PaneBindingManager,
} from "../../src/server/interaction/pane-binding-manager.js";

function bind(sessionId: string, time: number, sessionName: string, ordinal = time): PaneBindEvent {
  return {
    sessionId,
    time,
    ordinal,
    position: 0,
    attempt: { valid: true, ordinal, socketPath: "/tmp/shared.sock", sessionName },
  };
}

function permutations<T>(items: T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
      );
}

describe("PaneBindingManager", () => {
  it("keeps independent pane claims regardless of event order, batch boundaries or duplicate scans", () => {
    const events = [
      bind("A", 1, "ahub-00000000-0000-0000-0000-000000000001"),
      bind("B", 1, "ahub-00000000-0000-0000-0000-000000000002"),
      bind("C", 2, "ahub-00000000-0000-0000-0000-000000000001"),
      bind("C", 3, "ahub-00000000-0000-0000-0000-000000000002"),
    ];
    for (const order of permutations(events)) {
      const manager = new PaneBindingManager();
      for (const event of order) manager.submit(event);
      expect(manager.replacement("A")).toBe("C");
      expect(manager.replacement("B")).toBe("C");
      expect(
        manager.owns("C", {
          socketPath: "/tmp/shared.sock",
          sessionName: "ahub-00000000-0000-0000-0000-000000000002",
        }),
      ).toBe(true);
      for (const event of [...order].reverse()) manager.submit({ ...event });
      expect(manager.latest("C")).toEqual(events[3]!.attempt);
      expect(manager.replacement("A")).toBe("C");
      expect(manager.replacement("B")).toBe("C");
    }
  });

  it("lets an older session event independently replace a newer-than-pane event", () => {
    const manager = new PaneBindingManager();
    manager.submit(bind("C", 30, "ahub-00000000-0000-0000-0000-000000000002"));
    manager.submit(bind("A", 10, "ahub-00000000-0000-0000-0000-000000000001"));
    manager.submit(bind("C", 20, "ahub-00000000-0000-0000-0000-000000000001"));
    expect(manager.replacement("A")).toBe("C");
    expect(manager.latest("C")).toMatchObject({
      sessionName: "ahub-00000000-0000-0000-0000-000000000002",
    });
  });

  it("requires a new bind to refresh a superseded session and retains claims after an invalid bind", () => {
    const manager = new PaneBindingManager();
    const original = bind("A", 1, "ahub-00000000-0000-0000-0000-000000000001");
    manager.submit(original);
    manager.submit(bind("C", 2, "ahub-00000000-0000-0000-0000-000000000001"));
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
    manager.submit(bind("A", 4, "ahub-00000000-0000-0000-0000-000000000001"));
    expect(manager.replacement("A")).toBeNull();
    expect(
      manager.owns("A", {
        socketPath: "/tmp/shared.sock",
        sessionName: "ahub-00000000-0000-0000-0000-000000000001",
      }),
    ).toBe(true);
  });

  it("breaks equal timestamps by stable session ID, record ordinal and bind position", () => {
    const events = [
      bind("A", 1, "ahub-00000000-0000-0000-0000-000000000001"),
      bind("Z", 1, "ahub-00000000-0000-0000-0000-000000000001"),
      bind("Z", 1, "ahub-00000000-0000-0000-0000-000000000002", 2),
      { ...bind("Z", 1, "ahub-00000000-0000-0000-0000-000000000003", 2), position: 1 },
    ];
    for (const order of permutations(events)) {
      const manager = new PaneBindingManager();
      order.forEach((event) => manager.submit(event));
      expect(manager.replacement("A")).toBe("Z");
      expect(manager.latest("Z")).toMatchObject({
        sessionName: "ahub-00000000-0000-0000-0000-000000000003",
      });
    }
  });

  it("distinguishes socket paths and instance-namespaced sessions", () => {
    const manager = new PaneBindingManager();
    manager.submit(bind("instance-a/session", 1, "ahub-00000000-0000-0000-0000-000000000001"));
    manager.submit({
      ...bind("instance-b/session", 2, "ahub-00000000-0000-0000-0000-000000000001"),
      attempt: {
        valid: true,
        ordinal: 2,
        socketPath: "/tmp/other.sock",
        sessionName: "ahub-00000000-0000-0000-0000-000000000001",
      },
    });
    expect(manager.replacement("instance-a/session")).toBeNull();
    manager.submit(bind("instance-b/session", 3, "ahub-00000000-0000-0000-0000-000000000001"));
    expect(manager.replacement("instance-a/session")).toBe("instance-b/session");
  });
});

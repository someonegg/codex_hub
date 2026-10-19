import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ItemPageResponse,
  SessionUpdatesResponse,
  TimelineCursor,
  UpdateRevision,
} from "../../src/shared/api-contract";
import type { TimelineItem } from "../../src/shared/domain";

import { api } from "../../src/client/api/client";
import { SessionPage } from "../../src/client/SessionPage";
import { installIntersectionObserver, intersectLatest } from "./intersection-observer";
import {
  baseSession,
  json,
  NEXT_TIMELINE_CURSOR,
  SESSION_ID,
  TIMELINE_CURSOR,
  UPDATE_REVISION,
} from "./session.fixtures";

// @vitest-environment jsdom

const NEXT_REVISION = "opaque.updates.next" as UpdateRevision;
const OTHER_UPDATE_REVISION = "opaque.updates.other" as UpdateRevision;
const TAIL_CURSOR = "opaque.timeline.tail" as TimelineCursor;

beforeEach(() => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
});

describe("session automatic updates", () => {
  it.each([
    ["user input request", "request", true],
    ["user input response", "response", true],
    ["final plan", "plan", true],
    ["commentary plan", "commentary", false],
    ["ordinary final", "final", false],
    ["a plan followed by another message", "followed", false],
  ])("auto-expands the terminal preview for %s: %s", async (_label, kind, expands) => {
    installIntersectionObserver();
    const plan: TimelineItem = {
      ...message("Plan"),
      kind: "message",
      role: "assistant",
      phase: "final",
      itemType: "Plan",
    };
    let tail: TimelineItem[];
    if (kind === "request" || kind === "response") {
      tail = [
        {
          kind: "user_input",
          id: "input",
          ordinal: 2,
          timestamp: null,
          callId: "call",
          ...(kind === "request"
            ? { stage: "request" as const, questions: [] }
            : { stage: "response" as const, outcome: "answered" as const, answers: [] }),
        },
      ];
    } else if (kind === "commentary") {
      tail = [{ ...plan, phase: "commentary" }];
    } else if (kind === "final") {
      tail = [message("Done")];
    } else {
      tail = kind === "followed" ? [plan, message("Next message", 2)] : [plan];
    }
    // Background records must not hide the last conversation message.
    tail.push({
      kind: "internal",
      id: "internal",
      ordinal: 3,
      timestamp: null,
      eventType: "task_complete",
    });
    const connected = {
      supported: true as const,
      supersededBySessionId: null,
      state: "connected" as const,
      attachCommand: null,
    };
    vi.spyOn(api, "items").mockResolvedValue({ ...page(tail), interaction: connected });
    vi.spyOn(api, "updates").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "terminalPreview").mockResolvedValue({
      content: "pane",
      truncated: false,
      revision: "r".repeat(43),
      capturedAt: "2026-10-17T00:00:00Z",
    });
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
      "aria-expanded",
      String(expands),
    );
  });

  it("waits for the latest page before using the last loaded message to expand", async () => {
    installIntersectionObserver();
    const connected = {
      supported: true as const,
      supersededBySessionId: null,
      state: "connected" as const,
      attachCommand: null,
    };
    const plan: TimelineItem = {
      ...message("Plan"),
      kind: "message",
      role: "assistant",
      phase: "final",
      itemType: "Plan",
    };
    vi.spyOn(api, "items").mockResolvedValue({
      ...page([plan], TIMELINE_CURSOR, true),
      interaction: connected,
    });
    vi.spyOn(api, "updates").mockImplementation(() => new Promise(() => {}));
    const capture = vi.spyOn(api, "terminalPreview").mockResolvedValue({
      content: "pane",
      truncated: false,
      revision: "r".repeat(43),
      capturedAt: "2026-10-17T00:00:00Z",
    });
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps the draft and in-flight send across connection loss, then hides on archival", async () => {
    const connected = {
      supported: true as const,
      supersededBySessionId: null,
      state: "connected" as const,
      attachCommand: "tmux attach-session -t test",
    };
    vi.spyOn(api, "items").mockResolvedValue({ ...page([]), interaction: connected });
    let resolveUpdates!: (response: SessionUpdatesResponse) => void;
    vi.spyOn(api, "updates").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdates = resolve;
        }),
    );
    let rejectSend!: (reason: Error) => void;
    const send = vi.spyOn(api, "sendMessage").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {
      resolveUpdates(
        updates(false, NEXT_REVISION, {
          supported: true,
          supersededBySessionId: null,
          state: "unknown",
          attachCommand: null,
        }),
      );
    });
    await flush();
    expect(screen.queryByRole("textbox", { name: "Message to agent" })).not.toBeInTheDocument();
    expect(screen.getByText("Connection unknown")).toBeInTheDocument();
    await act(async () => {
      resolveUpdates(updates(false, OTHER_UPDATE_REVISION, connected));
    });
    await flush();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectSend(new Error("Send failed"));
    });
    await flush();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeEnabled();
    let previewSignal: AbortSignal | undefined;
    const capture = vi.spyOn(api, "terminalPreview").mockImplementation((_id, signal) => {
      previewSignal = signal;
      return new Promise(() => {});
    });
    fireEvent.click(screen.getByRole("button", { name: "Terminal preview" }));
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(previewSignal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "tmux access" }));
    expect(screen.getByRole("dialog", { name: "tmux access" })).toBeVisible();
    await act(async () => {
      const archived = updates(false, NEXT_REVISION);
      archived.session.status = "archived";
      resolveUpdates(archived);
    });
    await flush();
    expect(screen.queryByRole("region", { name: "Session interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message to agent" })).not.toBeInTheDocument();
    expect(previewSignal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("starts automatic updates by default, keeps one request, and cancels on unmount", async () => {
    let pendingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/updates?")) {
        pendingSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(json(page([message("Initial")])));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignal?.aborted).toBe(false);
    view.unmount();
    expect(pendingSignal?.aborted).toBe(true);
  });

  it("never opens automatic updates for archived sessions", async () => {
    installIntersectionObserver();
    const archivedPage = page([], TIMELINE_CURSOR, true, true);
    archivedPage.interaction = {
      supported: true,
      supersededBySessionId: null,
      state: "connected",
      attachCommand: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(json(archivedPage));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    expect(document.querySelector(".infinite-scroll-sentinel")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Session interaction" })).not.toBeInTheDocument();
  });

  it("loads ordinary items pages until a multi-page automatic updates backlog is caught up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page([message("One")], TIMELINE_CURSOR)))
      .mockResolvedValueOnce(json(updates(true, UPDATE_REVISION)))
      .mockResolvedValueOnce(
        json(page([message("Two", 2)], NEXT_TIMELINE_CURSOR, true, false, NEXT_REVISION)),
      )
      .mockResolvedValueOnce(
        json(
          updates(
            true,
            NEXT_REVISION,
            { supported: false, attachCommand: null },
            NEXT_TIMELINE_CURSOR,
          ),
        ),
      )
      .mockResolvedValueOnce(
        json(page([message("Three", 3)], TAIL_CURSOR, false, false, NEXT_REVISION)),
      )
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush(10);

    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByText("Three")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/updates?");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/items?");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=opaque.timeline.cursor");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("after=opaque.updates.next");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("cursor=opaque.timeline.next");
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("/items?");
    expect(String(fetchMock.mock.calls[5]?.[0])).toContain("cursor=opaque.timeline.tail");
  });

  it("discards an old automatic updates response after manual pagination advances the snapshot", async () => {
    installIntersectionObserver();
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page([message("One")], TIMELINE_CURSOR, true)))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce(
        json(page([message("Two", 2)], NEXT_TIMELINE_CURSOR, false, false, NEXT_REVISION)),
      )
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush();
    expect(document.querySelector(".infinite-scroll-sentinel")).toBeInTheDocument();
    intersectLatest();
    await flush(8);
    expect(screen.getByText("Two")).toBeInTheDocument();

    const obsolete = updates(false, OTHER_UPDATE_REVISION);
    resolveOld(
      json({
        ...obsolete,
        session: { ...obsolete.session, title: "Obsolete title" },
      }),
    );
    await flush(8);
    expect(screen.queryByRole("heading", { name: "Obsolete title" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  });

  it("adopts interaction and metadata-only automatic updates changes without advancing cursor", async () => {
    const changed = updates(false, NEXT_REVISION, {
      supported: true,
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected",
    });
    changed.session = {
      ...changed.session,
      title: "Changed title",
      itemCount: 7,
      updatedAt: "2026-08-08T12:34:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(json(changed))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdatedAt = vi.fn();
    render(<SessionPage sessionId={SESSION_ID} onUpdatedAt={onUpdatedAt} />);
    await flush();
    await flush(10);
    expect(screen.getByRole("heading", { name: "Changed title" })).toBeInTheDocument();
    expect(onUpdatedAt).toHaveBeenCalledWith(SESSION_ID, baseSession.updatedAt);
    expect(onUpdatedAt).toHaveBeenLastCalledWith(SESSION_ID, changed.session.updatedAt);
    expect(document.title).toBe("Changed title · Codex Hub");
    const localTime = new Date(changed.session.updatedAt!).toLocaleTimeString(undefined, {
      timeStyle: "medium",
    });
    expect(screen.getByText(`7 events · Updated ${localTime}`)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=opaque.timeline.cursor");
  });

  it("freezes the reader on an automatic updates timeline conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(page([message("Preserved")])))
        .mockResolvedValueOnce(
          json(
            {
              error: { code: "timeline_changed", message: "Timeline changed" },
            },
            409,
          ),
        ),
    );
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush(10);
    expect(screen.getByText("Preserved")).toBeInTheDocument();
    expect(screen.getByText("Session content has changed")).toBeInTheDocument();
  });

  it("reconnects immediately after consecutive 204 responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush(10);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("backs off retryable failures and stops on terminal 4xx responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(json({ error: { code: "busy", message: "Busy" } }, 503))
      .mockResolvedValueOnce(json({ error: { code: "invalid_query", message: "Stop" } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Stop")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("aborts while hidden and resumes immediately when visible", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/updates?")) return Promise.resolve(json(page([])));
      signals.push(init?.signal as AbortSignal);
      return abortable(init?.signal as AbortSignal);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionPage sessionId={SESSION_ID} />);
    await flush();
    await flush();
    expect(signals).toHaveLength(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
  });
});

async function flush(turns = 4) {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
  });
}

function abortable(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted", "AbortError")),
      { once: true },
    );
  });
}

function message(markdown: string, ordinal = 1): Extract<TimelineItem, { kind: "message" }> {
  return {
    kind: "message",
    id: `message-${ordinal}`,
    ordinal,
    timestamp: null,
    role: "assistant",
    phase: "final",
    itemType: null,
    markdown,
  };
}

function page(
  items: TimelineItem[],
  cursor: TimelineCursor = TIMELINE_CURSOR,
  hasMore = false,
  archived = false,
  updateRevision: UpdateRevision = UPDATE_REVISION,
): ItemPageResponse {
  return {
    session: {
      ...baseSession,
      status: archived ? "archived" : "normal",
      sourceId: "reader",
      itemCount: items.length,
    },
    items,
    cursor,
    hasMore,
    interaction: { supported: false, attachCommand: null },
    updateRevision,
  };
}

function updates(
  hasMore: boolean,
  updateRevision: UpdateRevision,
  interaction: SessionUpdatesResponse["interaction"] = { supported: false, attachCommand: null },
  cursor: TimelineCursor = TIMELINE_CURSOR,
): SessionUpdatesResponse {
  return {
    session: { ...baseSession, sourceId: "reader", itemCount: hasMore ? 2 : 0 },
    cursor,
    hasMore,
    interaction,
    updateRevision,
  };
}

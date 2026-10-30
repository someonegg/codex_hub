import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HubOperation, InteractionResponse } from "../../src/shared/api-contract";

import { api, ApiClientError } from "../../src/client/api/client";
import { CreateSession, ManageSession } from "../../src/client/components/HubManagement";
import { updatePreferences } from "../../src/client/state/preferences";
import { useHubOperation } from "../../src/client/state/use-hub-operation";
import { baseSession, SESSION_ID } from "./session.fixtures";

// @vitest-environment jsdom

const pending: HubOperation = {
  phase: null,
  attachCommand: null,
  operationId: "test-operation",
  type: "create",
  status: "pending",
  sessionId: null,
  error: null,
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};
describe("hub management", () => {
  it("uses current interaction state for ordered access and exit actions", async () => {
    const command = "tmux attach-session -t test";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const exit = vi.spyOn(api, "exitSession").mockResolvedValue({ ...pending, type: "exit" });
    const session = { ...baseSession, sourceId: "native", itemCount: 0 };
    const connected: InteractionResponse = {
      supported: true,
      state: "connected",
      activity: null,
      supersededBySessionId: null,
      attachCommand: command,
    };
    const { result } = renderHook(() => useHubOperation(session.id, vi.fn()));
    const controller = {
      ...result.current,
      busy: false,
      start: vi.fn(async (request: () => Promise<HubOperation>) => {
        await request();
      }),
    };
    const renderControls = (interaction: InteractionResponse | null, busy = false) => (
      <ManageSession
        session={session}
        interaction={interaction}
        controller={{ ...controller, busy }}
        onChanged={vi.fn()}
      />
    );
    const view = render(renderControls(connected));
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    open();
    expect(
      Array.from(
        document.querySelectorAll(".session-action-menu button"),
        (button) => button.textContent,
      ),
    ).toEqual(["Tmux access", "Archive session", "Exit session"]);
    fireEvent.click(screen.getByRole("button", { name: "Tmux access" }));
    expect(document.querySelector(".session-action-menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(command);
    fireEvent(
      screen.getByRole("dialog", { name: "tmux access" }),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.getByRole("button", { name: "Session management" })).toHaveFocus();
    open();
    view.rerender(renderControls(connected, true));
    expect(screen.getByRole("button", { name: "Exit session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive session" })).toBeDisabled();
    view.rerender(renderControls({ ...connected, state: "disconnected", attachCommand: null }));
    expect(screen.queryByRole("button", { name: "Exit session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tmux access" })).not.toBeInTheDocument();
    view.rerender(renderControls(connected));
    fireEvent.click(screen.getByRole("button", { name: "Exit session" }));
    await flush();
    expect(exit).toHaveBeenCalledWith(session.id);
    expect(document.querySelector(".session-action-menu")).toBeNull();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Tmux access" }));
    view.rerender(renderControls(null));
    expect(screen.queryByRole("dialog", { name: "tmux access" })).not.toBeInTheDocument();
  });
  it("renders management and creates requests without randomUUID in an HTTP context", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const create = vi.spyOn(api, "createSession").mockResolvedValue(pending);
    const archive = vi
      .spyOn(api, "archiveSession")
      .mockResolvedValue({ ...pending, type: "archive", phase: "waiting_exit" });
    const session = { ...baseSession, sourceId: "native", itemCount: 0 };
    render(<ManageSession session={session} onChanged={vi.fn()} />);
    render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    expect(document.querySelector(".session-action-menu")?.textContent).toBe("Archive session");
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await flush();
    expect(archive).toHaveBeenCalledWith(session.id);
    expect(screen.getByText("Waiting for exit")).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ yolo: false, requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }),
    );
  });

  it("uses a new request after definite failure but preserves it for uncertain retries", async () => {
    const create = vi
      .spyOn(api, "createSession")
      .mockResolvedValueOnce({ ...pending, status: "failed" })
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({ ...pending, status: "unknown" })
      .mockResolvedValueOnce(pending);
    render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
      await flush();
    }
    const ids = create.mock.calls.map(([input]) => input.requestId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[1]);
  });
  it("shows a separate creation placeholder, disables duplicate submits, and navigates only after observation", async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(api, "createSession").mockResolvedValue(pending);
    vi.spyOn(api, "operation").mockResolvedValue({
      ...pending,
      status: "succeeded",
      sessionId: SESSION_ID,
    });
    const onCreated = vi.fn();
    render(<CreateSession project="/project with spaces" projects={[]} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable worktree" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable YOLO mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await flush();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/project with spaces", worktree: true, yolo: true }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("pending");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID }));
  });
  it("restores pending tracking and clears the recovery marker for unknown results", async () => {
    sessionStorage.setItem("ahub.operation.create", pending.operationId);
    const get = vi
      .spyOn(api, "operation")
      .mockResolvedValue({ ...pending, status: "unknown", error: "Timed out" });
    const view = render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("unknown");
    expect(screen.queryByRole("button", { name: "Check result" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("ahub.operation.create")).toBeNull();
    view.unmount();
    render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
    await flush();
    expect(get).toHaveBeenCalledOnce();
  });
  it("offers archive without a binding and refreshes after observed completion", async () => {
    vi.useFakeTimers();
    const session = { ...baseSession, sourceId: "native", itemCount: 0 };
    const onChanged = vi.fn();
    const archive = vi
      .spyOn(api, "archiveSession")
      .mockResolvedValue({ ...pending, type: "archive", sessionId: SESSION_ID });
    vi.spyOn(api, "operation").mockResolvedValue({
      ...pending,
      type: "archive",
      sessionId: SESSION_ID,
      status: "succeeded",
    });
    const view = render(<ManageSession session={session} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    expect(screen.getByRole("button", { name: "Archive session" })).toBeEnabled();
    view.rerender(<ManageSession session={session} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    await flush();
    expect(archive).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Archive session" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Session management" })).toHaveFocus();
    view.rerender(
      <ManageSession session={{ ...session, status: "archived" as const }} onChanged={onChanged} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("refreshes an already archived session when recovering a successful archive operation", async () => {
    sessionStorage.setItem(`ahub.operation.${SESSION_ID}`, pending.operationId);
    vi.spyOn(api, "operation").mockResolvedValue({
      ...pending,
      type: "archive",
      sessionId: SESSION_ID,
      status: "succeeded",
    });
    const onChanged = vi.fn();
    const session = {
      ...baseSession,
      sourceId: "native",
      itemCount: 0,
      status: "archived" as const,
    };
    render(<ManageSession session={session} onChanged={onChanged} />);
    await flush();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(`ahub.operation.${SESSION_ID}`)).toBeNull();
  });
  it("requires confirmation before deleting an archived session", async () => {
    const session = {
      ...baseSession,
      sourceId: "native",
      itemCount: 0,
      status: "archived" as const,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deletion = vi
      .spyOn(api, "deleteSession")
      .mockResolvedValue({ ...pending, type: "delete", sessionId: SESSION_ID });
    render(<ManageSession session={session} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    expect(deletion).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Delete session" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Delete archived session" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent(
      screen.getByRole("dialog", { name: "Delete archived session" }),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(deletion).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Delete session" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Session management" }));
    expect(screen.getByRole("button", { name: "Delete session" })).toBeDisabled();
  });
});

it("hides attach until the server supplies it and stops polling after a terminal response", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "createSession").mockResolvedValue(pending);
  const get = vi
    .spyOn(api, "operation")
    .mockResolvedValueOnce({ ...pending, attachCommand: "tmux attach-session -t test" })
    .mockResolvedValueOnce({
      ...pending,
      status: "unknown",
      attachCommand: "tmux attach-session -t test",
    });
  render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(screen.getByText("Starting Codex")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy command" })).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(
    screen.getByText("No Codex session detected yet. Attach to tmux to check startup progress."),
  ).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(sessionStorage.getItem("ahub.operation.create")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
});

it("clears expired recovery markers on 404 while keeping retry for transient query failures", async () => {
  sessionStorage.setItem("ahub.operation.create", pending.operationId);
  const get = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new Error("network failure"))
    .mockRejectedValueOnce(new ApiClientError(404, "management_error", "Operation not found"));
  render(<CreateSession project="/project" projects={[]} onCreated={vi.fn()} />);
  await flush();
  expect(sessionStorage.getItem("ahub.operation.create")).toBe(pending.operationId);
  fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
  await flush();
  expect(get).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem("ahub.operation.create")).toBeNull();
});

it("serializes manual queries and ignores a response after scope changes", async () => {
  sessionStorage.setItem("ahub.operation.stale", pending.operationId);
  let resolve!: (op: HubOperation) => void;
  const get = vi.spyOn(api, "operation").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const success = vi.fn();
  const { result, rerender } = renderHook(({ scope }) => useHubOperation(scope, success), {
    initialProps: { scope: "stale" },
  });
  act(() => {
    result.current.check();
    result.current.check();
  });
  expect(get).toHaveBeenCalledOnce();
  const signal = get.mock.calls[0]![1]!;
  rerender({ scope: "fresh" });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolve({ ...pending, status: "succeeded" });
  });
  expect(result.current.operation).toBeNull();
  expect(result.current.busy).toBe(false);
  expect(success).not.toHaveBeenCalled();
});

it("blocks submission during recovery and transient failures until a terminal result", async () => {
  sessionStorage.setItem("ahub.operation.recovery", pending.operationId);
  let resolve!: (op: HubOperation) => void;
  const get = vi
    .spyOn(api, "operation")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce(new Error("network failure"))
    .mockResolvedValueOnce({ ...pending, status: "succeeded" });
  const submit = vi.fn().mockResolvedValue(pending);
  const { result } = renderHook(() => useHubOperation("recovery", vi.fn()));
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await result.current.start(submit);
  });
  expect(submit).not.toHaveBeenCalled();
  await act(async () => {
    resolve(pending);
  });
  act(() => result.current.check());
  await flush();
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await result.current.start(submit);
  });
  expect(submit).not.toHaveBeenCalled();
  act(() => result.current.check());
  await flush();
  expect(get).toHaveBeenCalledTimes(3);
  expect(result.current.busy).toBe(false);
});

it("keeps failed initial recovery locked until a 404 confirms removal", async () => {
  sessionStorage.setItem("ahub.operation.recovery", pending.operationId);
  vi.spyOn(api, "operation")
    .mockRejectedValueOnce(new Error("network failure"))
    .mockRejectedValueOnce(new ApiClientError(404, "management_error", "gone"));
  const submit = vi.fn().mockResolvedValue(pending);
  const { result } = renderHook(() => useHubOperation("recovery", vi.fn()));
  await flush();
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await result.current.start(submit);
  });
  expect(submit).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("ahub.operation.recovery")).toBe(pending.operationId);
  act(() => result.current.check());
  await flush();
  expect(result.current.busy).toBe(false);
  await act(async () => {
    await result.current.start(submit);
  });
  expect(submit).toHaveBeenCalledOnce();
});

it("automatically retries initial recovery, shows the error once, and stops at a terminal result", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  sessionStorage.setItem("ahub.operation.create", pending.operationId);
  const get = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new Error("offline during recovery"))
    .mockRejectedValueOnce(new Error("still offline"))
    .mockResolvedValueOnce({ ...pending, status: "succeeded" });
  const recovered = vi.fn();
  const created = vi.fn();
  render(
    <CreateSession
      project="/project"
      projects={[]}
      open={false}
      onRecovered={recovered}
      onCreated={created}
    />,
  );
  await flush();
  expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("offline during recovery");
  expect(recovered).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(recovered).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(created).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem("ahub.operation.create")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(get).toHaveBeenCalledTimes(3);
});

it("keeps nonretryable query failures locked with a manual query and does not retry submissions", async () => {
  vi.useFakeTimers();
  sessionStorage.setItem("ahub.operation.locked", pending.operationId);
  const get = vi
    .spyOn(api, "operation")
    .mockRejectedValueOnce(new ApiClientError(403, "forbidden", "Forbidden"))
    .mockResolvedValueOnce({ ...pending, status: "failed" });
  const { result } = renderHook(() => useHubOperation("locked", vi.fn()));
  await flush();
  expect(result.current.lifecycle).toBe("stopped");
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(get).toHaveBeenCalledOnce();
  act(() => result.current.check());
  await flush();
  expect(result.current.busy).toBe(false);
  const submit = vi.fn().mockRejectedValue(new Error("uncertain submission"));
  await act(async () => {
    await result.current.start(submit);
  });
  expect(result.current.errorPhase).toBe("submit");
  expect(result.current.canCheck).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(submit).toHaveBeenCalledOnce();
});

it("cancels hidden recovery reads and ignores late responses while a resumed manual read runs", async () => {
  vi.useFakeTimers();
  let visible: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  sessionStorage.setItem("ahub.operation.visibility", pending.operationId);
  let old!: (value: HubOperation) => void;
  let fresh!: (value: HubOperation) => void;
  const get = vi
    .spyOn(api, "operation")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          old = done;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          fresh = done;
        }),
    );
  const success = vi.fn();
  const { result, unmount } = renderHook(() => useHubOperation("visibility", success));
  visible = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(get.mock.calls[0]![1]?.aborted).toBe(true);
  act(() => result.current.check());
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(get).toHaveBeenCalledTimes(1);
  expect(result.current.busy).toBe(true);
  expect(result.current.error).toBeNull();
  visible = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => old({ ...pending, status: "succeeded" }));
  act(() => {
    result.current.check();
    result.current.check();
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(success).not.toHaveBeenCalled();
  await act(async () => fresh({ ...pending, status: "succeeded" }));
  expect(success).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(false);
  unmount();
});

it("preserves a submission received while hidden and immediately queries when visible", async () => {
  vi.useFakeTimers();
  let visible: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  let resolve!: (value: HubOperation) => void;
  const submit = vi.fn(
    () =>
      new Promise<HubOperation>((done) => {
        resolve = done;
      }),
  );
  const get = vi.spyOn(api, "operation").mockResolvedValue(pending);
  const { result, unmount } = renderHook(() => useHubOperation("hidden-submit", vi.fn()));
  let submitting!: Promise<void>;
  act(() => {
    submitting = result.current.start(submit);
  });
  visible = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => {
    resolve(pending);
    await submitting;
  });
  expect(sessionStorage.getItem("ahub.operation.hidden-submit")).toBe(pending.operationId);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(get).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(true);
  visible = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(get).toHaveBeenCalledOnce();
  unmount();
});

it.each([403, 503])(
  "preserves query errors while hidden and resumes only retryable status %s",
  async (status) => {
    vi.useFakeTimers();
    let visible: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
    sessionStorage.setItem("ahub.operation.hidden-error", pending.operationId);
    const get = vi
      .spyOn(api, "operation")
      .mockRejectedValueOnce(new ApiClientError(status, "error", "query failed"))
      .mockResolvedValue(pending);
    const { result, unmount } = renderHook(() => useHubOperation("hidden-error", vi.fn()));
    await flush();
    visible = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(get).toHaveBeenCalledOnce();
    expect(result.current.error).toBe("query failed");
    expect(result.current.busy).toBe(true);
    visible = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(get).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
    unmount();
  },
);

it("offers a yolo-only resume dialog and shares operation occupancy with the management menu", async () => {
  const { ResumeSession, OperationStatus } = await import(
    "../../src/client/components/HubManagement"
  );
  const create = vi
    .spyOn(api, "createSession")
    .mockResolvedValue({ ...pending, mode: "resume", sessionId: SESSION_ID });
  const session = { ...baseSession, resume: { allowed: true, reason: null } };
  function Harness() {
    const controller = useHubOperation(session.id, vi.fn());
    return (
      <>
        <ResumeSession session={session} controller={controller} />
        <ManageSession session={session} onChanged={vi.fn()} controller={controller} />
        <OperationStatus controller={controller} />
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(screen.getByRole("dialog", { name: "Resume session" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Resume session" })).toHaveFocus();
  expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).not.toBeChecked();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Enable worktree" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable YOLO mode" }));
  act(() => updatePreferences({ yolo: true }));
  act(() => updatePreferences({ yolo: false }));
  expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Close resume session" }));
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable YOLO mode" }));
  fireEvent.click(screen.getByRole("button", { name: "Resume session" }));
  await flush();
  expect(create).toHaveBeenCalledWith({
    resumeSessionId: session.id,
    yolo: true,
    requestId: expect.any(String),
  });
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Session management" }));
  expect(screen.getByRole("button", { name: "Archive session" })).toBeDisabled();
  expect(screen.getByText("resume · pending")).toBeInTheDocument();
});

it("initializes creation options only when opening the dialog", () => {
  const homes = [{ nickname: "default" }, { nickname: "work" }, { nickname: "other" }];
  act(() => updatePreferences({ defaultHome: "default" }));
  const props = { homes, project: "/project", projects: [], onCreated: vi.fn() };
  const view = render(<CreateSession {...props} open={false} />);
  view.rerender(<CreateSession {...props} open />);
  expect(screen.getByLabelText("Session home")).toHaveValue("default");
  fireEvent.change(screen.getByLabelText("Session home"), { target: { value: "work" } });
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/manual" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable worktree" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable YOLO mode" }));
  act(() => updatePreferences({ defaultHome: "other", worktree: true, yolo: true }));
  act(() => updatePreferences({ worktree: false, yolo: false }));
  view.rerender(<CreateSession {...props} project="/updated" open />);
  expect(screen.getByLabelText("Project directory")).toHaveValue("/manual");
  expect(screen.getByRole("checkbox", { name: "Enable worktree" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).toBeChecked();
  expect(screen.getByLabelText("Session home")).toHaveValue("work");
  view.rerender(<CreateSession {...props} open={false} />);
  view.rerender(<CreateSession {...props} open />);
  expect(screen.getByLabelText("Session home")).toHaveValue("other");
  expect(screen.getByLabelText("Project directory")).toHaveValue("/project");
  expect(screen.getByRole("checkbox", { name: "Enable worktree" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Enable YOLO mode" })).not.toBeChecked();
  act(() => updatePreferences({ defaultHome: "" }));
});

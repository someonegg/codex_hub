import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HubOperation, SessionListResponse } from "../../src/shared/api-contract";

import { api, ApiClientError } from "../../src/client/api/client";
import { App } from "../../src/client/App";
import { browserStorage } from "../../src/client/state/browser-storage";
import { baseSession, CHILD_ID, firstPage, listBody, SESSION_ID } from "./session.fixtures";

// @vitest-environment jsdom

const archiveId = "archivedabcdefghijklmnop";
const catalog: SessionListResponse = {
  ...listBody,
  sessions: [
    ...listBody.sessions,
    {
      ...listBody.sessions[0]!,
      id: archiveId,
      title: "Archived trace",
      status: "archived" as const,
    },
    {
      ...listBody.sessions[0]!,
      id: CHILD_ID,
      parentId: SESSION_ID,
      title: "Child trace",
      isChild: true,
    },
  ],
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};
beforeEach(() => {
  sessionStorage.clear();
  browserStorage.setItem(
    "ahub.navigation",
    JSON.stringify({ includeArchived: false, expanded: ["/project/reader"], scroll: 0 }),
  );
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(api, "sessions")
    .mockResolvedValueOnce(catalog)
    .mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, "messages").mockImplementation(async (id, query) =>
    query.wait
      ? new Promise(() => {})
      : {
          ...firstPage,
          hasMore: false,
          session: {
            ...baseSession,
            id,
            parentId: id === CHILD_ID ? SESSION_ID : null,
            status: "archived" as const,
            title:
              id === CHILD_ID
                ? "Child trace"
                : id === archiveId
                  ? "Archived trace"
                  : baseSession.title,
          },
        },
  );
});
describe("unified hub", () => {
  it.each([503, 400])(
    "keeps catalog errors visible with retry status matching HTTP %s",
    async (status) => {
      window.history.replaceState(null, "", "/");
      vi.mocked(api.sessions)
        .mockReset()
        .mockRejectedValueOnce(new ApiClientError(status, "request_failed", "Catalog unavailable"))
        .mockImplementation(() => new Promise(() => {}));
      render(<App />);
      await flush();
      const alert = screen.getByRole("alert");
      expect(within(alert).queryByText("Automatically retrying…") !== null).toBe(status === 503);
      expect(api.sessions).toHaveBeenCalledTimes(1);
    },
  );

  it("remembers child session expansion and collapse after remounting", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    let view = render(<App />);
    await flush();
    const group = () => screen.getByText("Child sessions · 1").closest("details")!;
    expect(group()).not.toHaveAttribute("open");
    group().open = true;
    fireEvent(group(), new Event("toggle"));
    await flush();
    view.unmount();

    vi.mocked(api.sessions).mockResolvedValueOnce(catalog);
    view = render(<App />);
    await flush();
    expect(group()).toHaveAttribute("open");
    group().open = false;
    fireEvent(group(), new Event("toggle"));
    await flush();
    view.unmount();

    vi.mocked(api.sessions).mockResolvedValueOnce(catalog);
    render(<App />);
    await flush();
    expect(group()).not.toHaveAttribute("open");
  });

  it("offers a agent link below a missing session error without redirecting automatically", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.mocked(api.messages).mockRejectedValue(
      new ApiClientError(404, "session_not_found", "Session missing"),
    );
    render(<App />);
    await flush();

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Session not found");
    const link = screen.getByRole("link", { name: "Back to home" });
    expect(link).toHaveAttribute("href", "/");
    expect(error.nextElementSibling).toBe(link);
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
    expect(screen.queryByRole("button", { name: "Retry opening session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry session deletion/ })).toBeNull();

    fireEvent.click(link);
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(
      screen.getByRole("heading", { name: "Select a session from the sidebar" }),
    ).toBeInTheDocument();
  });

  it("keeps retry available for other session loading errors", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.mocked(api.messages).mockRejectedValueOnce(
      new ApiClientError(500, "internal_error", "Load failed"),
    );
    render(<App />);
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load session");
    expect(screen.queryByRole("link", { name: "Back to home" })).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry opening session" });
    expect(screen.getByRole("alert")).toContainElement(retry);
    fireEvent.click(retry);
    await flush();
    expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  });

  it.each([false, true])(
    "respects creation dialog dismissal on completion: %s",
    async (dismiss) => {
      vi.useFakeTimers();
      const pending: HubOperation = {
        phase: null,
        attachCommand: null,
        operationId: "create-op",
        type: "create",
        status: "pending",
        sessionId: null,
        error: null,
        createdAt: "2026-10-16T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
      };
      vi.spyOn(api, "createSession").mockResolvedValue(pending);
      vi.spyOn(api, "operation").mockResolvedValue({
        ...pending,
        status: "succeeded",
        sessionId: CHILD_ID,
      });
      render(<App />);
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "New session in reader" }));
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
      fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
      await flush();
      if (dismiss) {
        fireEvent.click(screen.getByRole("button", { name: "Close new session" }));
        fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
        fireEvent.click(screen.getByRole("link", { name: /Reader work/ }));
        await flush();
        fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      if (dismiss) {
        expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
        expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("link", { name: "Open session" }));
        await flush();
      }
      expect(screen.getByRole("button", { name: /^reader.*1/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(window.location.pathname).toBe(`/sessions/${CHILD_ID}`);
      expect(screen.getByRole("heading", { name: "Child trace" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open session" })).toBeNull();
    },
  );
  it("expands the destination project when following the bound-session link", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.mocked(api.messages).mockImplementation(async (id, query) =>
      query.wait
        ? new Promise(() => {})
        : {
            ...firstPage,
            hasMore: false,
            session: { ...baseSession, id },
            interaction: {
              supported: true,
              state: "superseded",
              activity: null,
              supersededBySessionId: CHILD_ID,
              attachCommand: null,
            },
          },
    );
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
    expect(screen.getByRole("button", { name: /^reader.*1/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("link", { name: "Go to bound session" }));
    await flush();
    expect(window.location.pathname).toBe(`/sessions/${CHILD_ID}`);
    expect(screen.getByRole("button", { name: /^reader.*1/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("opens nothing on agent, toggles archived records, and retains navigation through history", async () => {
    render(<App />);
    await flush();
    const nav = screen.getByRole("navigation", { name: "Projects and main sessions" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Child trace/ })).not.toBeInTheDocument();
    expect(api.messages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));
    expect(within(nav).getAllByRole("link")).toHaveLength(2);
    fireEvent.click(within(nav).getByRole("link", { name: /Reader work/ }));
    await flush();
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
    expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
    const childGroup = screen.getByText("Child sessions · 1").closest("details")!;
    expect(childGroup).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Child sessions · 1"));
    expect(screen.getByRole("link", { name: "Child trace" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back to list/ }));
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("checkbox", { name: "Archived" })).toBeChecked();
    act(() => {
      window.history.replaceState(null, "", `/sessions/${archiveId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(screen.getByRole("heading", { name: "Archived trace" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));
    expect(within(nav).queryByRole("link", { name: /Archived trace/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Archived trace" })).toBeInTheDocument();
  });

  it("keeps the parent link when its summary is unavailable and retains nested children", async () => {
    window.history.replaceState(null, "", `/sessions/${CHILD_ID}`);
    vi.mocked(api.sessions)
      .mockReset()
      .mockResolvedValueOnce({
        ...catalog,
        sessions: [
          catalog.sessions.find((session) => session.id === CHILD_ID)!,
          {
            ...listBody.sessions[0]!,
            id: "grandchild",
            title: "Nested child",
            parentId: CHILD_ID,
            isChild: true,
          },
        ],
      })
      .mockImplementation(() => new Promise(() => {}));
    render(<App />);
    await flush();
    expect(
      within(screen.getByRole("navigation", { name: "Parent session" })).getByRole("link", {
        name: "← Parent session",
      }),
    ).toHaveAttribute("href", `/sessions/${SESSION_ID}`);
    fireEvent.click(screen.getByText("Child sessions · 1"));
    expect(screen.getByRole("link", { name: "Nested child" })).toHaveAttribute(
      "href",
      "/sessions/grandchild",
    );
  });
  it("uses project-prefilled creation dialogs and persists collapsed projects", async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New session in reader" }));
    const dialog = screen.getByRole("dialog", { name: "New session" });
    expect(within(dialog).getByRole("combobox", { name: "Project directory" })).toHaveValue(
      "/project/reader",
    );
    expect(within(dialog).getByRole("heading", { name: "New session" })).toHaveFocus();
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    fireEvent.focus(within(dialog).getByRole("combobox", { name: "Project directory" }));
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Project directory"), {
      target: { value: "custom" },
    });
    fireEvent.change(within(dialog).getByLabelText("Custom directory"), {
      target: { value: "/new/project" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close new session" }));
    fireEvent.click(screen.getByRole("button", { name: "New session in reader" }));
    expect(within(dialog).getByRole("heading", { name: "New session" })).toHaveFocus();
    expect(within(dialog).getByLabelText("Project directory")).toHaveValue("/project/reader");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close new session" }));
    fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
    expect(screen.queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
    expect(JSON.parse(browserStorage.getItem("ahub.navigation")!).expanded).toEqual([]);
  });
});

describe("hub link entry points", () => {
  it("preserves modified child clicks and navigates on primary click", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    render(<App />);
    await flush();
    fireEvent.click(screen.getByText("Child sessions · 1"));
    const child = screen.getByRole("link", { name: "Child trace" });
    expect(fireEvent.click(child, { metaKey: true })).toBe(true);
    expect(fireEvent.click(child, { button: 2 })).toBe(true);
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
    fireEvent.click(child);
    expect(window.location.pathname).toBe(`/sessions/${CHILD_ID}`);
  });
});

it("feeds displayed session updatedAt back into sidebar ordering without refreshing the catalog", async () => {
  window.history.replaceState(null, "", "/");
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce({
      ...listBody,
      sessions: [
        { ...listBody.sessions[0]!, updatedAt: null },
        {
          ...listBody.sessions[0]!,
          id: "other",
          title: "Other session",
          updatedAt: "2026-07-28T10:30:00Z",
        },
      ],
    })
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  const sidebar = screen.getByRole("complementary", { name: "Session list" });
  const order = () =>
    within(sidebar)
      .getAllByRole("link")
      .slice(1)
      .map((link) => link.getAttribute("href"));
  expect(order()).toEqual(["/sessions/other", `/sessions/${SESSION_ID}`]);
  fireEvent.click(within(sidebar).getByRole("link", { name: "Reader work" }));
  await flush();
  expect(order()).toEqual([`/sessions/${SESSION_ID}`, "/sessions/other"]);
  expect(
    within(sidebar)
      .getByRole("link", { name: /Reader work/ })
      .querySelector("time"),
  ).toHaveAttribute("datetime", baseSession.updatedAt);
  expect(api.sessions).toHaveBeenCalledTimes(2);
});

function multiAgentCatalog(): SessionListResponse {
  return {
    ...catalog,
    agents: [
      { nickname: "personal", runtimeName: "Codex" },
      { nickname: "work", runtimeName: "Claude Code" },
      { nickname: "empty", runtimeName: "Codex" },
    ],
    sessions: [
      ...catalog.sessions.map((session) => ({ ...session, agent: "personal" })),
      {
        ...catalog.sessions[0]!,
        id: "work-session",
        title: "Work trace",
        agent: "work",
      },
    ],
  };
}
it("aggregates and filters merged projects, remembers the agent and keeps a direct-linked reader open", async () => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiAgentCatalog())
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  const sidebar = screen.getByRole("complementary", { name: "Session list" });
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toHaveTextContent("work");
  expect(within(sidebar).getAllByRole("button", { name: /reader, 2 main sessions/ })).toHaveLength(
    1,
  );
  expect(screen.getByText("Agent: default")).toBeInTheDocument();
  expect(within(sidebar).getByRole("option", { name: "work · Claude Code" })).toHaveValue("work");
  expect(within(sidebar).getByRole("option", { name: "empty · Codex" })).toHaveValue("empty");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by agent" }), {
    target: { value: "work" },
  });
  expect(within(sidebar).queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  expect(browserStorage.getItem("ahub.agent")).toBe("work");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by agent" }), {
    target: { value: "empty" },
  });
  expect(within(sidebar).getByText("No main sessions yet")).toBeInTheDocument();
  fireEvent.click(within(sidebar).getByRole("button", { name: "New session" }));
  expect(screen.getByLabelText("Session agent")).toHaveValue("empty");
  expect(
    within(screen.getByLabelText("Session agent")).getByRole("option", {
      name: "work · Claude Code",
    }),
  ).toHaveValue("work");
});
it("defaults creation to the first agent in aggregate view and restores a stored filter", async () => {
  window.history.replaceState(null, "", "/");
  browserStorage.setItem("ahub.agent", "removed-source");
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiAgentCatalog())
    .mockImplementation(() => new Promise(() => {}));
  const view = render(<App />);
  await flush();
  expect(screen.getByLabelText("Filter by agent")).toHaveValue("");
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Custom directory"), { target: { value: "/project" } });
  expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Session agent"), { target: { value: "work" } });
  expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
  const create = vi
    .spyOn(api, "createSession")
    .mockRejectedValue(new Error("Test submission stopped"));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ agent: "work", projectDirectory: "/project" }),
  );
  fireEvent.change(screen.getByLabelText("Filter by agent"), { target: { value: "work" } });
  view.unmount();
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiAgentCatalog())
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  expect(screen.getByLabelText("Filter by agent")).toHaveValue("work");
});

it("preselects the default creation agent and respects an explicit agent filter", async () => {
  window.history.replaceState(null, "", "/");
  const list = multiAgentCatalog();
  list.agents[2] = { nickname: "default", runtimeName: "Codex" };
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(list)
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session agent")).toHaveValue(list.agents[0]!.nickname);
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Custom directory"), { target: { value: "/project" } });
  const create = vi.spyOn(api, "createSession").mockRejectedValue(new Error("Test stopped"));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ agent: list.agents[0]!.nickname, projectDirectory: "/project" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new session" }));
  fireEvent.change(screen.getByLabelText("Filter by agent"), { target: { value: "work" } });
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session agent")).toHaveValue("work");
});

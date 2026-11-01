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
  vi.spyOn(api, "items").mockImplementation(async (id) => ({
    ...firstPage,
    hasMore: false,
    session: {
      ...baseSession,
      id,
      parentId: id === CHILD_ID ? SESSION_ID : null,
      status: "archived" as const,
      title:
        id === CHILD_ID ? "Child trace" : id === archiveId ? "Archived trace" : baseSession.title,
    },
  }));
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
  it.each([503, 400])(
    "keeps an opened session error non-dismissible with accurate recovery status for HTTP %s",
    async (status) => {
      window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
      vi.mocked(api.items)
        .mockReset()
        .mockResolvedValue({ ...firstPage, hasMore: false });
      vi.spyOn(api, "updates")
        .mockRejectedValueOnce(new ApiClientError(status, "request_failed", "Reader unavailable"))
        .mockImplementation(() => new Promise(() => {}));
      render(<App />);
      await flush();
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Reader unavailable");
      expect(within(alert).queryByRole("button")).toBeNull();
      expect(within(alert).queryByText("Automatically retrying…") !== null).toBe(status === 503);
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

  it("offers a home link below a missing session error without redirecting automatically", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.mocked(api.items).mockRejectedValue(
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
    vi.mocked(api.items).mockRejectedValueOnce(
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
    vi.mocked(api.items).mockImplementation(async (id) => ({
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
    }));
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

  it("opens nothing on home, toggles archived records, and retains navigation through history", async () => {
    render(<App />);
    await flush();
    const nav = screen.getByRole("navigation", { name: "Projects and main sessions" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Child trace/ })).not.toBeInTheDocument();
    expect(api.items).not.toHaveBeenCalled();
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Close new session" }));
    fireEvent.click(screen.getByRole("button", { name: "New session in reader" }));
    expect(within(dialog).getByRole("heading", { name: "New session" })).toHaveFocus();
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.focus(within(dialog).getByRole("combobox", { name: "Project directory" }));
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close new session" }));
    fireEvent.click(screen.getByRole("button", { name: /^reader.*1/ }));
    expect(screen.queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
    expect(JSON.parse(browserStorage.getItem("ahub.navigation")!).expanded).toEqual([]);
  });
});

it("keeps archived content open while removing navigation, then returns to the project list after deletion", async () => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
  let archived = false;
  vi.spyOn(api, "sessions")
    .mockReset()
    .mockResolvedValueOnce(catalog)
    .mockImplementation((query) =>
      query.after
        ? new Promise(() => {})
        : Promise.resolve({
            ...catalog,
            revision: "b".repeat(43),
            sessions: catalog.sessions.map((item) =>
              item.id === SESSION_ID ? { ...item, status: archived ? "archived" : "normal" } : item,
            ),
          }),
    );
  vi.spyOn(api, "items").mockImplementation(async () => ({
    ...firstPage,
    hasMore: false,
    session: { ...baseSession, status: archived ? "archived" : "normal" },
  }));
  vi.spyOn(api, "updates").mockImplementation(() => new Promise(() => {}));
  const operation = {
    phase: null,
    attachCommand: null,
    operationId: "archive-op",
    type: "archive",
    status: "succeeded",
    sessionId: SESSION_ID,
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
    error: null,
  } as const;
  vi.spyOn(api, "archiveSession").mockImplementation(async () => {
    archived = true;
    return operation;
  });
  vi.spyOn(api, "deleteSession").mockResolvedValue({
    ...operation,
    type: "delete",
    operationId: "delete-op",
  });
  render(<App />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Session management" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
  await flush();
  const nav = screen.getByRole("navigation", { name: "Projects and main sessions" });
  expect(within(nav).queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
  fireEvent.click(screen.getByRole("button", { name: "Session management" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await flush();
  expect(window.location.pathname).toBe("/");
  expect(
    screen.getByRole("heading", { name: "Select a session from the sidebar" }),
  ).toBeInTheDocument();
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

function multiHomeCatalog(): SessionListResponse {
  return {
    ...catalog,
    homes: [{ nickname: "personal" }, { nickname: "work" }, { nickname: "empty" }],
    sessions: [
      ...catalog.sessions.map((session) => ({ ...session, home: "personal" })),
      {
        ...catalog.sessions[0]!,
        id: "work-session",
        title: "Work trace",
        home: "work",
      },
    ],
  };
}
it("aggregates and filters merged projects, remembers the home and keeps a direct-linked reader open", async () => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiHomeCatalog())
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  const sidebar = screen.getByRole("complementary", { name: "Session list" });
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toHaveTextContent("work");
  expect(within(sidebar).getAllByRole("button", { name: /reader, 2 main sessions/ })).toHaveLength(
    1,
  );
  expect(screen.getByText("Home: default")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by home" }), {
    target: { value: "work" },
  });
  expect(within(sidebar).queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  expect(browserStorage.getItem("ahub.home")).toBe("work");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by home" }), {
    target: { value: "empty" },
  });
  expect(within(sidebar).getByText("No main sessions yet")).toBeInTheDocument();
  fireEvent.click(within(sidebar).getByRole("button", { name: "New session" }));
  expect(screen.getByLabelText("Session home")).toHaveValue("empty");
});
it("requires explicit creation home in aggregate view and restores a stored filter", async () => {
  window.history.replaceState(null, "", "/");
  browserStorage.setItem("ahub.home", "removed-source");
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiHomeCatalog())
    .mockImplementation(() => new Promise(() => {}));
  const view = render(<App />);
  await flush();
  expect(screen.getByLabelText("Filter by home")).toHaveValue("");
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/project" } });
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Session home"), { target: { value: "work" } });
  expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
  const create = vi
    .spyOn(api, "createSession")
    .mockRejectedValue(new Error("Test submission stopped"));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ home: "work", projectDirectory: "/project" }),
  );
  fireEvent.change(screen.getByLabelText("Filter by home"), { target: { value: "work" } });
  view.unmount();
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(multiHomeCatalog())
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  expect(screen.getByLabelText("Filter by home")).toHaveValue("work");
});

it("preselects the default creation home and respects an explicit home filter", async () => {
  window.history.replaceState(null, "", "/");
  const list = multiHomeCatalog();
  list.homes[2] = { nickname: "default" };
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(list)
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session home")).toHaveValue("default");
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/project" } });
  const create = vi.spyOn(api, "createSession").mockRejectedValue(new Error("Test stopped"));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ home: "default", projectDirectory: "/project" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new session" }));
  fireEvent.change(screen.getByLabelText("Filter by home"), { target: { value: "work" } });
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session home")).toHaveValue("work");
});

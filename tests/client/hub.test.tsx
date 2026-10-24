import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HubOperation, SessionListResponse } from "../../src/shared/api-contract";

import { api, ApiClientError } from "../../src/client/api/client";
import { App } from "../../src/client/App";
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
  sessionStorage.setItem(
    "codex-hub.navigation",
    JSON.stringify({ includeArchived: false, expanded: ["project-reader"], scroll: 0 }),
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
    fireEvent.click(screen.getByRole("button", { name: "Retry opening session" }));
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
      await flush();
      if (dismiss) {
        fireEvent.click(screen.getByRole("button", { name: "Close new session" }));
        fireEvent.click(screen.getByRole("link", { name: /Reader work/ }));
        await flush();
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
      expect(window.location.pathname).toBe(`/sessions/${CHILD_ID}`);
      expect(screen.getByRole("heading", { name: "Child trace" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open session" })).toBeNull();
    },
  );
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
  it("preserves project navigation scroll when the mobile sidebar becomes hidden", async () => {
    render(<App />);
    await flush();
    const nav = screen.getByRole("navigation", { name: "Projects and main sessions" });
    const rects = vi.spyOn(nav, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    fireEvent.scroll(nav, { target: { scrollTop: 240 } });
    fireEvent.click(within(nav).getByRole("link", { name: /Reader work/ }));
    await flush();
    rects.mockReturnValue([] as unknown as DOMRectList);
    fireEvent.scroll(nav, { target: { scrollTop: 0 } });
    expect(JSON.parse(sessionStorage.getItem("codex-hub.navigation")!).scroll).toBe(240);
    rects.mockReturnValue([{}] as unknown as DOMRectList);
    fireEvent.click(screen.getByRole("button", { name: /Back to list/ }));
    await flush();
    expect(nav.scrollTop).toBe(240);
  });
  it("keeps projects collapsed by default when opening a direct child link", async () => {
    sessionStorage.removeItem("codex-hub.navigation");
    window.history.replaceState(null, "", `/sessions/${CHILD_ID}`);
    render(<App />);
    await flush();
    expect(screen.getByRole("heading", { name: "Child trace" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Projects and main sessions" });
    expect(within(nav).getByRole("button", { name: /^reader.*1/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(nav).getByRole("button", { name: /^reader.*1/ }));
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).queryByRole("link", { name: /Child trace/ })).not.toBeInTheDocument();
  });
  it("returns from a child to its immediate parent in the related-session area", async () => {
    window.history.replaceState(null, "", `/sessions/${CHILD_ID}`);
    render(<App />);
    await flush();
    const related = screen.getByRole("navigation", { name: "Parent session" });
    const parent = within(related).getByRole("link", { name: "← Parent session · Reader work" });
    expect(parent).toHaveAttribute("href", `/sessions/${SESSION_ID}`);
    expect(fireEvent.click(parent, { metaKey: true })).toBe(true);
    expect(window.location.pathname).toBe(`/sessions/${CHILD_ID}`);
    fireEvent.click(parent);
    await flush();
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
    expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Parent session" })).not.toBeInTheDocument();
    expect(screen.getByText("Child sessions · 1")).toBeInTheDocument();
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
    expect(JSON.parse(sessionStorage.getItem("codex-hub.navigation")!).expanded).toEqual([]);
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
  await flush();
  expect(window.location.pathname).toBe("/");
  expect(
    screen.getByRole("heading", { name: "Select a session from the sidebar" }),
  ).toBeInTheDocument();
});

it("formats a fixed large catalog once and reuses dates when groups and selection change", async () => {
  const count = 1000;
  const sessions = Array.from({ length: count }, (_, index) => ({
    ...listBody.sessions[0]!,
    id: index === 0 ? SESSION_ID : `session-${index}`,
    title: `Large catalog ${index}`,
  }));
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce({ ...listBody, sessions })
    .mockImplementation(() => new Promise(() => {}));
  const format = vi.fn(() => "formatted date");
  vi.spyOn(Intl.DateTimeFormat.prototype as { format: unknown }, "format", "get").mockReturnValue(
    format,
  );
  render(<App />);
  await flush();
  expect(format).toHaveBeenCalledTimes(count);
  const group = screen.getByRole("button", { name: /reader, 1000 main sessions/ });
  fireEvent.click(group);
  fireEvent.click(group);
  expect(format).toHaveBeenCalledTimes(count);
  // Avoid computing accessible names for all 1,000 links in this cache regression test.
  const link = screen.getByText("Large catalog 0", { exact: true }).closest("a")!;
  expect(link).toHaveAttribute("href", `/sessions/${SESSION_ID}`);
  fireEvent.click(link);
  await flush();
  expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
  expect(format.mock.calls.length).toBeLessThan(count + 5);
});

describe("hub link entry points", () => {
  it("preserves modified and non-primary brand clicks and navigates on primary click", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    render(<App />);
    await flush();
    const brand = screen.getByRole("link", { name: /Codex Hub/ });
    expect(fireEvent.click(brand, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(brand, { button: 1 })).toBe(true);
    expect(window.location.pathname).toBe(`/sessions/${SESSION_ID}`);
    fireEvent.click(brand);
    expect(window.location.pathname).toBe("/");
  });

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
  const sidebar = screen.getByRole("complementary", { name: "Session catalog" });
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
    homes: [
      { sourceInstanceId: "source-instance", nickname: "personal" },
      { sourceInstanceId: "work", nickname: "work" },
      { sourceInstanceId: "empty", nickname: "empty" },
    ],
    sessions: [
      ...catalog.sessions,
      {
        ...catalog.sessions[0]!,
        id: "work-session",
        title: "Work trace",
        sourceInstanceId: "work",
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
  const sidebar = screen.getByRole("complementary", { name: "Session catalog" });
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toHaveTextContent("work");
  expect(within(sidebar).getAllByRole("button", { name: /reader, 2 main sessions/ })).toHaveLength(
    1,
  );
  expect(screen.getByText("Home: personal")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by home" }), {
    target: { value: "work" },
  });
  expect(within(sidebar).queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
  expect(within(sidebar).getByRole("link", { name: /Work trace/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  expect(sessionStorage.getItem("codex-hub.home")).toBe("work");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by home" }), {
    target: { value: "empty" },
  });
  expect(within(sidebar).getByText("No main sessions yet")).toBeInTheDocument();
  fireEvent.click(within(sidebar).getByRole("button", { name: "New session" }));
  expect(screen.getByLabelText("Session home")).toHaveValue("empty");
});
it("requires explicit creation home in aggregate view and restores a stored filter", async () => {
  window.history.replaceState(null, "", "/");
  sessionStorage.setItem("codex-hub.home", "removed-source");
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
    expect.objectContaining({ sourceInstanceId: "work", directory: "/project" }),
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
  list.homes[2] = { sourceInstanceId: "empty", nickname: "default" };
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValueOnce(list)
    .mockImplementation(() => new Promise(() => {}));
  render(<App />);
  await flush();
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session home")).toHaveValue("empty");
  fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/project" } });
  const create = vi.spyOn(api, "createSession").mockRejectedValue(new Error("Test stopped"));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await flush();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ sourceInstanceId: "empty", directory: "/project" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close new session" }));
  fireEvent.change(screen.getByLabelText("Filter by home"), { target: { value: "work" } });
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(screen.getByLabelText("Session home")).toHaveValue("work");
});

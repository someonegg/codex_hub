// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ArtifactsPage } from "../../src/client/components/ArtifactsPage";
import { safeUrlTransform } from "../../src/client/components/MessageItem";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("only permits exact hosted-page relative links alongside existing absolute protocols", () => {
  const url = `/web/${"a".repeat(32)}/`;
  expect(safeUrlTransform(url)).toBe(url);
  for (const value of [
    "//evil.test",
    "javascript:alert(1)",
    url + "extra",
    "/web/invalid/",
    "/artifacts",
    "data:text/html,test",
  ])
    expect(safeUrlTransform(value)).toBe("");
  expect(safeUrlTransform("https://example.com")).toBe("https://example.com");
});
it("groups offline projects, copies absolute links and confirms deletion", async () => {
  const artifact = {
    id: "a".repeat(32),
    title: "方案对比",
    updatedAt: "2026-10-24T00:00:00Z",
    url: `/web/${"a".repeat(32)}/`,
  };
  let deleted = false;
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      projects: deleted ? [] : [{ directory: "/projects/no-sessions", artifacts: [artifact] }],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<ArtifactsPage />);
  await screen.findByText(artifact.title);
  expect(screen.getByText("/projects/no-sessions")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(copy).toHaveBeenCalledWith(location.origin + artifact.url);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(deleted).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.getByText("No published web pages.")).toBeInTheDocument());
});
it("keeps the page shell visible and controls busy until deletion and list reload finish", async () => {
  const artifact = {
    id: "b".repeat(32),
    title: "Published demo",
    updatedAt: "2026-10-24T00:00:00Z",
    url: `/web/${"b".repeat(32)}/`,
  };
  let resolveList!: (response: Response) => void;
  let resolveDelete!: (response: Response) => void;
  const fetcher = vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        if (init?.method === "DELETE") resolveDelete = resolve;
        else resolveList = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<ArtifactsPage />);
  const refresh = screen.getByRole("button", { name: "Refresh" });
  expect(screen.getByRole("heading", { name: "Pages" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading pages…");
  expect(refresh).toBeDisabled();
  resolveList(Response.json({ projects: [{ directory: "/project", artifacts: [artifact] }] }));
  await screen.findByText(artifact.title);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(refresh).toBeDisabled();
  resolveDelete(new Response(null, { status: 204 }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(refresh).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  resolveList(Response.json({ projects: [] }));
  await screen.findByText("No published web pages.");
  expect(refresh).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

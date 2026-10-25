// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DiffPage } from "../../src/client/components/DiffPage";

afterEach(() => vi.unstubAllGlobals());

it("groups file navigation by directory and opens a collapsed file on navigation", async () => {
  const paths = ["src/main.ts", "src/state/store.ts", "src", "README.md"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        title: "Review",
        raw: paths
          .map((path) => `diff --git a/${path} b/${path}\nold mode 100644\nnew mode 100755\n`)
          .join(""),
      }),
    ),
  );
  render(<DiffPage />);
  await screen.findByRole("heading", { name: "Review" });
  expect(screen.queryByText("View original diff")).not.toBeInTheDocument();
  const navigation = screen.getByRole("navigation", { name: "Changed files" });
  expect(navigation.querySelectorAll("details")).toHaveLength(2);
  const nestedLink = screen.getByRole("link", { name: "store.ts" });
  expect(nestedLink).toHaveAttribute("href", "#file-1");
  expect(nestedLink.closest("details")?.querySelector("summary")).toHaveTextContent("state");
  expect(screen.getByRole("link", { name: "src" })).toHaveAttribute("href", "#file-2");
  const file = document.getElementById("file-1") as HTMLDetailsElement;
  file.open = false;
  fireEvent.click(nestedLink);
  expect(file.open).toBe(true);
});

it("keeps original text accessible when the diff cannot be fully parsed", async () => {
  const raw = "Unrecognized format: <script>unsafe</script>";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ title: "Unsupported diff", raw })),
  );
  render(<DiffPage />);
  await screen.findByRole("status");
  expect(screen.getByText("View original diff")).toBeInTheDocument();
  expect(screen.getByText(raw)).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
});

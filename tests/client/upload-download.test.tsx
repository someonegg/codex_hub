// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UploadDownload } from "../../src/client/components/UploadDownload";

const item = {
  id: "one",
  sessionId: "session",
  filename: "photo.jpeg",
  type: "image/jpeg",
  size: 3,
  uploadedAt: "2026-11-02T00:00:00Z",
  path: "/tmp/photo.jpeg",
};
const href = "/api/v1/sessions/session/uploads/one/content?download=1";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const share = vi.fn().mockResolvedValue(undefined);
  const canShare = vi.fn().mockReturnValue(true);
  vi.stubGlobal("navigator", { userAgent: "iPhone", standalone: true, share, canShare });
  const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["abc"]) });
  vi.stubGlobal("fetch", fetch);
  render(<UploadDownload item={item} href={href} />);
  return { share, canShare, fetch };
}
it("prepares a typed file without navigating and shares only on a second click; cancellation allows retry", async () => {
  const { share, fetch } = setup();
  share.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByRole("button", { name: "Save file" });
  expect(share).not.toHaveBeenCalled();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(href, { signal: expect.any(AbortSignal) });
  fireEvent.click(screen.getByRole("button", { name: "Save file" }));
  await screen.findByRole("button", { name: "Cancel" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const file = share.mock.calls[0]![0].files[0] as File;
  expect(file.name).toBe(item.filename);
  expect(file.type).toBe(item.type);
  expect(file.size).toBe(3);
  fireEvent.click(screen.getByRole("button", { name: "Save file" }));
  await screen.findByRole("button", { name: "Download" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(share).toHaveBeenCalledTimes(2);
});
it("keeps unsupported files on the app page and explains the Safari alternative", async () => {
  const { canShare, share } = setup();
  canShare.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Open Codex Hub in Safari");
  expect(share).not.toHaveBeenCalled();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("allows retry after a failed fetch and cancellation releases the prepared file", async () => {
  const { fetch } = setup();
  fetch.mockResolvedValueOnce({ ok: false });
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to download");
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByRole("button", { name: "Save file" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
});
it("retains native downloading outside iOS standalone mode", () => {
  render(<UploadDownload item={item} href={href} />);
  expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", href);
  expect(screen.getByRole("link")).toHaveAttribute("download", item.filename);
});

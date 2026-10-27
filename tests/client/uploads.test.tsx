// @vitest-environment jsdom
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { UploadAttachment } from "../../src/shared/uploads";

import { api } from "../../src/client/api/client";
import { UploadsPage } from "../../src/client/components/UploadsPage";
import { SessionDraftProvider, useSessionDraft } from "../../src/client/state/session-drafts";

const item: UploadAttachment = {
  id: "file-1",
  sessionId: "session-one",
  filename: "photo.png",
  type: "image/png",
  size: 100,
  uploadedAt: "2026-10-26T00:00:00Z",
  path: "/tmp/photo.png",
};
afterEach(() => vi.restoreAllMocks());
function Draft() {
  const draft = useSessionDraft(item.sessionId);
  return (
    <>
      <button
        onClick={() =>
          draft.addAttachment({
            id: item.id,
            path: item.path,
            file: new File(["x"], item.filename),
          })
        }
      >
        Stage
      </button>
      <span data-testid="draft-count">{draft.attachments.length}</span>
    </>
  );
}
it("preserves failed deletion, supports inline retry, and removes the matching draft in StrictMode", async () => {
  vi.spyOn(api, "uploads").mockResolvedValue({ items: [item] });
  const remove = vi
    .spyOn(api, "deleteUpload")
    .mockRejectedValueOnce(new Error("Disk busy"))
    .mockResolvedValue({ deleted: true });
  render(
    <StrictMode>
      <SessionDraftProvider>
        <Draft />
        <UploadsPage sessionId={item.sessionId} onBack={() => {}} />
      </SessionDraftProvider>
    </StrictMode>,
  );
  await screen.findByText(item.filename);
  fireEvent.click(screen.getByText("Stage"));
  fireEvent.click(screen.getByRole("button", { name: "Expand photo.png" }));
  expect(screen.getByRole("button", { name: "Collapse photo.png" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk busy");
  expect(screen.getByTestId("draft-count")).toHaveTextContent("1");
  expect(remove.mock.calls[0]![2].aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await screen.findByText("No uploads yet.");
  expect(screen.getByTestId("draft-count")).toHaveTextContent("0");
});
it("retries initial errors, loads the full history, and aborts requests on unmount", async () => {
  const list = vi
    .spyOn(api, "uploads")
    .mockRejectedValueOnce(new Error("Session not found"))
    .mockResolvedValue({
      items: [item, { ...item, id: "file-2", filename: "other.txt", type: "text/plain" }],
    });
  const view = render(<UploadsPage sessionId={item.sessionId} onBack={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Session not found");
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByText(item.filename);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText(/Preview unavailable/)).toBeInTheDocument();
  expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  await screen.findByText("other.txt");
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  const signal = list.mock.calls[1]![1];
  view.unmount();
  expect(signal.aborted).toBe(true);
});

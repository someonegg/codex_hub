// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionMessagesResponse } from "../../src/shared/api-contract";

import { api } from "../../src/client/api/client";
import { SessionReader } from "../../src/client/components/SessionReader";
import { firstPage } from "./session.fixtures";

vi.mock("../../src/client/api/terminal-preview", () => ({
  connectTerminalPreview: () => vi.fn(),
}));

const page: SessionMessagesResponse = {
  ...firstPage,
  hasMore: false,
  interaction: {
    supported: true,
    activity: null,
    state: "connected",
    supersededBySessionId: null,
    attachCommand: null,
  },
};
const reader = (context = page) => (
  <SessionReader context={context} readerLoading={false} readerBusy={false} onLoadMore={vi.fn()} />
);
const preview = () => screen.queryByRole("list", { name: "Pending" });
async function send(message = "Show this immediately") {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Message to agent" }), message);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  vi.spyOn(api, "sendMessage").mockResolvedValue(undefined);
});

describe("temporary message preview", () => {
  it("appears before the send completes, survives metadata updates, and yields to any actual message", async () => {
    let complete!: () => void;
    vi.mocked(api.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const view = render(reader());
    await send();
    expect(preview()).toHaveTextContent("Show this immediately");
    expect(preview()?.querySelector("time")).toBeNull();
    await act(async () => complete());
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(preview()).toBeInTheDocument();
    view.rerender(
      reader({ ...page, session: { ...page.session, updatedAt: "2026-11-05T12:00:00Z" } }),
    );
    expect(preview()).toBeInTheDocument();
    view.rerender(
      reader({
        ...page,
        items: [
          ...page.items,
          {
            kind: "message",
            id: "actual",
            ordinal: 2,
            timestamp: null,
            role: "assistant",
            phase: "update",
            itemType: null,
            markdown: "Actual content wins",
          },
        ],
      }),
    );
    expect(preview()).not.toBeInTheDocument();
    expect(screen.getByText("Actual content wins")).toBeInTheDocument();
  });

  it("does not restore a preview if actual messages arrive before the send completes", async () => {
    let complete!: () => void;
    vi.mocked(api.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const view = render(reader());
    await send();
    view.rerender(
      reader({ ...page, items: [...page.items, { ...page.items[0]!, id: "actual", ordinal: 2 }] }),
    );
    expect(preview()).not.toBeInTheDocument();
    await act(async () => complete());
    expect(preview()).not.toBeInTheDocument();
  });

  it("withdraws a failed send and retains its draft", async () => {
    vi.mocked(api.sendMessage).mockRejectedValue(new Error("Send failed"));
    render(reader());
    await send();
    expect(preview()).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Show this immediately");
    expect(screen.getByRole("alert")).toHaveTextContent("Send failed");
  });

  it.each(["/help", "/plan", "/exit", "/quit"])("excludes pure command %s", async (command) => {
    render(reader());
    await send(command);
    expect(preview()).not.toBeInTheDocument();
    expect(api.sendMessage).toHaveBeenCalledWith(page.session.id, command);
  });

  it("uses one temporary slot and clears it on session changes", async () => {
    const view = render(reader());
    await send("First temporary message");
    await send("Latest temporary message");
    expect(preview()).not.toHaveTextContent("First temporary message");
    expect(preview()).toHaveTextContent("Latest temporary message");
    view.rerender(reader({ ...page, session: { ...page.session, id: "another" } }));
    expect(preview()).not.toBeInTheDocument();
    view.rerender(reader());
    expect(preview()).not.toBeInTheDocument();
  });
});

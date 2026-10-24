import { type ComponentProps, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { InteractionResponse } from "../../src/shared/api-contract";

import { InteractionPanel as Panel } from "../../src/client/components/InteractionPanel";

// @vitest-environment jsdom

function interaction(state: "unbound" | "disconnected" | "connected"): InteractionResponse {
  return {
    supported: true,
    activity: null,
    supersededBySessionId: null,
    attachCommand: null,
    state,
  };
}

function props(value: InteractionResponse | null) {
  return {
    interaction: value,
    itemCount: 12,
    updatedAt: "2026-08-08T12:00:00.000Z",
    interactionBusy: false,
    error: null,
    onDismissError: vi.fn(),
    onHandoffPaneBinding: vi.fn().mockResolvedValue(undefined),
    onExpandPreview: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onSendKeys: vi.fn().mockResolvedValue(undefined),
    preview: null,
    previewBusy: false,
    previewStopped: false,
    onRetryPreview: vi.fn(),
    previewError: null,
    onDismissPreviewError: vi.fn(),
    onTogglePreview: vi.fn(),
  };
}

function InteractionPanel(properties: Omit<ComponentProps<typeof Panel>, "previewExpanded">) {
  const [expanded, setExpanded] = useState(properties.preview !== null);
  return (
    <Panel
      {...properties}
      previewExpanded={expanded}
      onExpandPreview={() => {
        properties.onExpandPreview();
        setExpanded(true);
      }}
      onTogglePreview={() => {
        properties.onTogglePreview();
        setExpanded((value) => !value);
      }}
    />
  );
}

describe("interaction panel", () => {
  it("reveals the panel on expansion and collapse without focusing the composer", async () => {
    const user = userEvent.setup();
    render(<InteractionPanel {...props(interaction("connected"))} />);
    const panel = screen.getByRole("region", { name: "Session interaction" });
    const scrollIntoView = vi.fn();
    panel.scrollIntoView = scrollIntoView;
    const toggle = screen.getByRole("button", { name: "Terminal Preview" });
    await user.click(toggle);
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
      behavior: "instant",
    });
    await user.click(toggle);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).not.toHaveFocus();
  });

  it("focuses the preview once on expansion, including before output arrives", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const toggle = screen.getByRole("button", { name: "Terminal Preview" });
    await user.click(toggle);
    const previewBody = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(previewBody).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(handlers.onSendKeys).toHaveBeenCalledWith(["up"]);
    const composer = screen.getByRole("textbox", { name: "Message to agent" });
    await user.click(composer);
    rerender(
      <InteractionPanel
        {...handlers}
        preview={{
          content: "fresh output",
          truncated: false,
          revision: "r".repeat(43),
          capturedAt: "2026-08-08",
        }}
      />,
    );
    expect(composer).toHaveFocus();
    await user.click(toggle);
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveFocus();
  });

  it("retains the draft when sending fails", async () => {
    const handlers = props(interaction("connected"));
    handlers.onSendMessage.mockRejectedValueOnce(new Error("offline"));
    render(<InteractionPanel {...handlers} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsent draft" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("textbox")).toHaveValue("unsent draft");
    expect(handlers.onSendMessage).toHaveBeenCalledOnce();
  });

  it("retains the panel and draft through every unavailable state", () => {
    const handlers = props(interaction("connected"));
    const view = render(<InteractionPanel {...handlers} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), {
      target: { value: "draft" },
    });
    const states: Array<InteractionResponse | null> = [
      interaction("disconnected"),
      {
        supported: true,
        activity: null,
        supersededBySessionId: null,
        state: "unknown",
        attachCommand: null,
      },
      interaction("unbound"),
      null,
      { supported: false, attachCommand: null },
    ];
    for (const state of states) {
      view.rerender(<InteractionPanel {...handlers} interaction={state} />);
      expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Terminal Preview" })).not.toBeInTheDocument();
    }
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    view.rerender(<InteractionPanel {...handlers} />);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("draft");
  });

  it.each(["unbound", "disconnected", "unsupported"] as const)(
    "shows connection information without input on initial %s state",
    (state) => {
      const value: InteractionResponse =
        state === "unsupported"
          ? { supported: false, attachCommand: null }
          : {
              supported: true,
              activity: null,
              state,
              supersededBySessionId: null,
              attachCommand: null,
            };
      render(<InteractionPanel {...props(value)} />);
      expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Terminal Preview" })).not.toBeInTheDocument();
    },
  );

  it("inserts a newline on Enter, sends on Shift+Enter, and clears after success", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);
    const textarea = screen.getByRole("textbox", { name: "Message to agent" });
    await user.type(textarea, "line one{enter}line two");
    expect(textarea).toHaveValue("line one\nline two");
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(handlers.onSendMessage).toHaveBeenCalledWith("line one\nline two");
    expect(await screen.findByRole("textbox", { name: "Message to agent" })).toHaveValue("");
  });

  it("keeps Send disabled for blank input", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);
    const textarea = screen.getByRole("textbox", { name: "Message to agent" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    await user.type(textarea, "   ");
    expect(send).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("   ");
  });

  it("dispatches interaction controls and locks the composer and action buttons while busy", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    expect(screen.getByText(/12 events · Updated/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" }).parentElement).toHaveClass(
      "interaction-primary-actions",
    );
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal Preview" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(handlers.onSendKeys).toHaveBeenNthCalledWith(1, ["interrupt"]);
    expect(handlers.onSendKeys).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox"), "draft");
    const interrupt = screen.getByRole("button", { name: "Interrupt" });
    interrupt.focus();
    handlers.onSendKeys.mockClear();
    handlers.onSendMessage.mockClear();
    rerender(<InteractionPanel {...handlers} interactionBusy />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("draft");
    expect(interrupt).toHaveFocus();
    expect(interrupt).toBeEnabled();
    expect(interrupt).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Terminal Preview" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(interrupt);
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
    expect(handlers.onSendMessage).not.toHaveBeenCalled();

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute("aria-disabled", "true");
    await user.click(send);
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
  });

  it("renders a truncated terminal preview as plain text", () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "\u001b[31mplain text<img src=x onerror=alert(1)><script>alert(2)</script>",
        truncated: true,
        revision: "r".repeat(43),
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    render(<InteractionPanel {...handlers} />);

    const content = screen.getByLabelText("Terminal Preview content");
    expect(content).toHaveTextContent(
      "plain text<img src=x onerror=alert(1)><script>alert(2)</script>",
    );
    expect(content.querySelector("img")).toBeNull();
    expect(content.querySelector("script")).toBeNull();
    expect(screen.getByText(/terminal output exceeded the preview limit/i)).toBeInTheDocument();
  });

  it("sends the six terminal keys from the rectangular terminal keypad", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "output",
        truncated: false,
        revision: "r".repeat(43),
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const keypad = screen.getByRole("group", { name: "Terminal controls" });
    expect(keypad).toBeInTheDocument();
    expect([...keypad.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Enter",
      "↑",
      "Plan",
      "←",
      "↓",
      "→",
    ]);

    for (const name of ["Enter", "Up", "Plan", "Left", "Down", "Right"]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(handlers.onSendKeys.mock.calls).toEqual([
      [["enter"]],
      [["up"]],
      [["plan"]],
      [["left"]],
      [["down"]],
      [["right"]],
    ]);

    rerender(<InteractionPanel {...handlers} interactionBusy />);
    handlers.onSendKeys.mockClear();
    for (const name of ["Enter", "Up", "Plan", "Left", "Down", "Right"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
    }
    expect(handlers.onSendKeys).not.toHaveBeenCalled();
  });
});

it("uses four composer rows without an empty connected heading", () => {
  render(<InteractionPanel {...props(interaction("connected"))} />);
  expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveAttribute("rows", "4");
  expect(document.querySelector(".interaction-heading")).toBeNull();
});

it.each([
  ["/plan", true],
  ["/plan now", false],
  ["hello", false],
])("expands the preview after successfully sending %s: %s", async (message, expands) => {
  const handlers = props(interaction("connected"));
  render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: message } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Terminal Preview" })).toHaveAttribute(
    "aria-expanded",
    String(expands),
  );
});

it("waits for successful command delivery and keeps an expanded preview open", async () => {
  let resolve!: () => void;
  const handlers = props(interaction("connected"));
  handlers.onSendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  render(<InteractionPanel {...handlers} />);
  const toggle = screen.getByRole("button", { name: "Terminal Preview" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/plan" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await act(async () => resolve());
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/status" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});

it("does not expand on failed command delivery", async () => {
  const handlers = props(interaction("connected"));
  handlers.onSendMessage.mockRejectedValueOnce(new Error("offline"));
  render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/plan" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Terminal Preview" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByRole("textbox")).toHaveValue("/plan");
});

it("expands the preview after handoff without changing the draft and disables Handoff while busy or disconnected", async () => {
  const handlers = props(interaction("connected"));
  const view = render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(handlers.onHandoffPaneBinding).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Handoff" })).toHaveAttribute(
    "title",
    "Hand off this pane’s binding to the active Codex session.",
  );
  expect(screen.getByRole("textbox")).toHaveValue("draft");
  expect(screen.getByRole("button", { name: "Terminal Preview" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  view.rerender(<InteractionPanel {...handlers} interactionBusy />);
  expect(screen.getByRole("button", { name: "Handoff" })).toBeDisabled();
  view.rerender(<InteractionPanel {...handlers} interaction={interaction("disconnected")} />);
  expect(screen.queryByRole("button", { name: "Handoff" })).not.toBeInTheDocument();
});

it("ignores command completion after the panel unmounts", async () => {
  let resolve!: () => void;
  const handlers = props(interaction("connected"));
  handlers.onSendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/plan" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.unmount();
  await act(async () => resolve());
  expect(handlers.onExpandPreview).not.toHaveBeenCalled();
});

it("shows takeover beside the status, preserves drafts, and navigates to the replacement", () => {
  const handlers = props(interaction("connected"));
  const onNavigate = vi.fn();
  const view = render(<InteractionPanel {...handlers} onNavigate={onNavigate} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
  view.rerender(
    <InteractionPanel
      {...handlers}
      onNavigate={onNavigate}
      interaction={{
        supported: true,
        activity: null,
        state: "superseded",
        supersededBySessionId: "replacement",
        attachCommand: null,
      }}
    />,
  );
  const status = screen.getByText("Superseded");
  expect(
    screen.queryByText("This pane is bound to another session. Your draft is preserved."),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Connection unavailable/)).not.toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Go to bound session" });
  expect(link.parentElement).toBe(status.parentElement);
  expect(link).toHaveAttribute("href", "/sessions/replacement");
  fireEvent.click(link);
  expect(onNavigate).toHaveBeenCalledWith("replacement");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  for (const name of ["Send", "Handoff", "Plan", "Terminal Preview"])
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  view.rerender(<InteractionPanel {...props(interaction("connected"))} />);
  expect(screen.getByRole("textbox")).toHaveValue("draft");
});

it("shows the takeover even on first load, with no link when its session is missing", () => {
  render(
    <InteractionPanel
      {...props({
        supported: true,
        activity: null,
        state: "superseded",
        supersededBySessionId: null,
        attachCommand: null,
      })}
    />,
  );
  expect(screen.getByText("Superseded")).toBeVisible();
  expect(screen.getByText("Replacement session unavailable")).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("waits for successful handoff delivery before expanding the preview", async () => {
  let resolve!: () => void;
  const handlers = props(interaction("connected"));
  handlers.onHandoffPaneBinding.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  render(<InteractionPanel {...handlers} />);
  const toggle = screen.getByRole("button", { name: "Terminal Preview" });
  fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await act(async () => resolve());
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});

it("does not expand the preview after failed handoff delivery", async () => {
  const handlers = props(interaction("connected"));
  handlers.onHandoffPaneBinding.mockRejectedValueOnce(new Error("offline"));
  render(<InteractionPanel {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Terminal Preview" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it.each([
  ["Escape", "interrupt"],
  ["Enter", "enter"],
  ["ArrowLeft", "left"],
])("maps physical %s in the preview and prevents defaults", (physical, key) => {
  const handlers = props(interaction("connected"));
  render(<Panel {...handlers} previewExpanded />);
  const body = screen.getByRole("group", { name: "Terminal controls" }).parentElement!;
  body.focus();
  expect(body).toHaveFocus();
  expect(fireEvent.keyDown(body, { key: physical })).toBe(false);
  expect(handlers.onSendKeys).toHaveBeenLastCalledWith([key]);
  const button = screen.getByRole("button", { name: /^Left$/ });
  button.focus();
  expect(fireEvent.keyDown(button, { key: physical })).toBe(false);
  expect(handlers.onSendKeys).toHaveBeenCalledTimes(2);
  expect(handlers.onTogglePreview).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
});

it("preserves editing and unrelated keyboard actions and blocks sends while busy or folded", () => {
  const handlers = props(interaction("connected"));
  const view = render(<Panel {...handlers} previewExpanded />);
  const body = screen.getByRole("group", { name: "Terminal controls" }).parentElement!;
  for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey", "isComposing"]) {
    for (const key of ["Enter", "Escape"]) {
      expect(fireEvent.keyDown(body, { key, [modifier]: true })).toBe(true);
    }
  }
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" })).toBe(true);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Terminal Preview" }), { key: "Enter" }),
  ).toBe(true);
  expect(handlers.onSendKeys).not.toHaveBeenCalled();
  fireEvent.click(body);
  expect(body).toHaveFocus();
  view.rerender(<Panel {...handlers} interactionBusy previewExpanded />);
  expect(fireEvent.keyDown(body, { key: "Enter" })).toBe(false);
  expect(fireEvent.keyDown(body, { key: "Escape" })).toBe(false);
  expect(handlers.onSendKeys).not.toHaveBeenCalled();
  view.rerender(<Panel {...handlers} previewExpanded interaction={interaction("disconnected")} />);
  fireEvent.keyDown(body, { key: "Enter" });
  expect(handlers.onSendKeys).not.toHaveBeenCalled();
  view.rerender(<Panel {...handlers} previewExpanded={false} />);
  expect(screen.queryByRole("group", { name: "Terminal controls" })).toBeNull();
});

it("sends once when Enter is pressed on a terminal button", async () => {
  const handlers = props(interaction("connected"));
  const user = userEvent.setup();
  render(<Panel {...handlers} previewExpanded />);
  screen.getByRole("button", { name: /^Up$/ }).focus();
  await user.keyboard("{Enter}");
  expect(handlers.onSendKeys).toHaveBeenCalledExactlyOnceWith(["enter"]);
});

it("ignores Interrupt and Plan while busy, including preview expansion", () => {
  const handlers = props(interaction("connected"));
  const view = render(<Panel {...handlers} interactionBusy previewExpanded={false} />);
  const interrupt = screen.getByRole("button", { name: "Interrupt" });
  expect(interrupt).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(interrupt);
  view.rerender(<Panel {...handlers} interactionBusy previewExpanded />);
  const plan = screen.getByRole("button", { name: "Plan" });
  expect(plan).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(plan);
  expect(handlers.onSendKeys).not.toHaveBeenCalled();
  expect(handlers.onExpandPreview).not.toHaveBeenCalled();
});

describe("composer uploads", () => {
  it("inserts files in order at the selection, freezes controls and restores the caret", async () => {
    const { api } = await import("../../src/client/api/client");
    let finish!: (value: { path: string }) => void;
    const upload = vi
      .spyOn(api, "upload")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ path: "/tmp/two.txt" });
    const handlers = props(interaction("connected"));
    render(<InteractionPanel {...handlers} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "before replace after" } });
    input.setSelectionRange(7, 14);
    fireEvent.paste(input, {
      clipboardData: { files: [new File(["one"], "one.png"), new File(["two"], "two.txt")] },
    });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Handoff" })).toBeDisabled();
    expect(screen.getByText("Uploading 1/2…")).toBeInTheDocument();
    await act(async () => finish({ path: "/tmp/space dir/one.png" }));
    expect(input.value).toBe('before "/tmp/space dir/one.png" /tmp/two.txt after');
    expect(input).toBeEnabled();
    await vi.waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(input.value.indexOf(" after"));
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  it("keeps successful paths after failure and stops the batch", async () => {
    const { api } = await import("../../src/client/api/client");
    const upload = vi
      .spyOn(api, "upload")
      .mockResolvedValueOnce({ path: "/tmp/one.txt" })
      .mockRejectedValueOnce(new Error("Disk full"));
    render(<InteractionPanel {...props(interaction("connected"))} />);
    const input = screen.getByRole("textbox");
    fireEvent.drop(input, {
      dataTransfer: { files: [1, 2, 3].map((n) => new File(["x"], `${n}.txt`)), items: [] },
    });
    await screen.findByText("Disk full");
    expect(input).toHaveValue("/tmp/one.txt");
    expect(input).toBeEnabled();
    expect(upload).toHaveBeenCalledTimes(2);
    upload.mockRestore();
  });

  it("aborts on unmount and ignores late responses", async () => {
    const { api } = await import("../../src/client/api/client");
    let finish!: (value: { path: string }) => void;
    const upload = vi.spyOn(api, "upload").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<InteractionPanel {...props(interaction("connected"))} />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [new File(["x"], "a.txt")] },
    });
    const signal = upload.mock.calls[0]![1];
    view.unmount();
    expect(signal.aborted).toBe(true);
    render(<InteractionPanel {...props(interaction("connected"))} />);
    await act(async () => finish({ path: "/tmp/old.txt" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    upload.mockRestore();
  });

  it("leaves ordinary text paste alone and rejects oversized files before uploading", async () => {
    const { api } = await import("../../src/client/api/client");
    const upload = vi.spyOn(api, "upload");
    render(<InteractionPanel {...props(interaction("connected"))} />);
    const input = screen.getByRole("textbox");
    expect(
      fireEvent.paste(input, { clipboardData: { files: [], getData: () => "/local/file.txt" } }),
    ).toBe(true);
    const file = new File(["x"], "large.txt");
    Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 + 1 });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    expect(await screen.findByText("Files must be at most 20 MiB")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(input).toBeEnabled();
    upload.mockRestore();
  });
});

it("adds a MIME extension to clipboard images and refuses new uploads while busy", async () => {
  const { api } = await import("../../src/client/api/client");
  let finish!: (value: { path: string }) => void;
  const upload = vi.spyOn(api, "upload").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<InteractionPanel {...props(interaction("connected"))} />);
  const input = screen.getByRole("textbox");
  const clipboard = {
    clipboardData: { files: [new File(["pixels"], "clipboard", { type: "image/png" })] },
  };
  fireEvent.paste(input, clipboard);
  expect(upload.mock.calls[0]![0].name).toBe("clipboard.png");
  fireEvent.paste(input, clipboard);
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => finish({ path: "/tmp/image.png" }));
  upload.mockRestore();
});

it("rejects folders without uploading", async () => {
  const { api } = await import("../../src/client/api/client");
  const upload = vi.spyOn(api, "upload");
  render(<InteractionPanel {...props(interaction("connected"))} />);
  fireEvent.drop(screen.getByRole("textbox"), {
    dataTransfer: {
      files: [],
      items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
    },
  });
  expect(await screen.findByText("Folders are not supported")).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
  upload.mockRestore();
});

it.each(["working", "idle"] as const)(
  "renders activity %s independently of preview expansion",
  (activity) => {
    const value = { ...interaction("connected"), activity } as InteractionResponse;
    const view = render(<Panel {...props(value)} previewExpanded={false} />);
    for (const expanded of [false, true]) {
      view.rerender(<Panel {...props(value)} previewExpanded={expanded} />);
      expect(screen.getByText(activity === "working" ? "Working" : "Idle")).toBeVisible();
    }
  },
);

describe("image attachments", () => {
  it("navigates the menu, dismisses it and restores focus", async () => {
    const user = userEvent.setup();
    render(<InteractionPanel {...props(interaction("connected"))} />);
    const trigger = screen.getByRole("button", { name: "Attach images" });
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Take photo" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Choose images" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}{End}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft" } });
    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
  });

  it("opens separate camera and gallery inputs and preserves the selection across repeated choices", async () => {
    const { api } = await import("../../src/client/api/client");
    const upload = vi.spyOn(api, "upload").mockResolvedValue({ path: "/tmp/photo space.jpg" });
    const user = userEvent.setup();
    const handlers = props(interaction("connected"));
    render(<InteractionPanel {...handlers} />);
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    const camera = screen.getByLabelText("Take photo") as HTMLInputElement;
    const gallery = screen.getByLabelText("Choose images") as HTMLInputElement;
    expect(camera).toHaveAttribute("capture", "environment");
    expect(camera).not.toHaveAttribute("multiple");
    expect(gallery).toHaveAttribute("multiple");
    expect(gallery).not.toHaveAttribute("capture");
    expect(camera).toHaveAttribute("accept", "image/*");
    expect(gallery).toHaveAttribute("accept", "image/*");
    fireEvent.change(composer, { target: { value: "before replace after" } });
    composer.setSelectionRange(7, 14);
    for (const [name, input] of [
      ["Take photo", camera],
      ["Choose images", gallery],
    ] as const) {
      const click = vi.spyOn(input, "click");
      await user.click(screen.getByRole("button", { name: "Attach images" }));
      await user.click(screen.getByRole("menuitem", { name }));
      expect(click).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      // A cancelled picker does not change the draft.
      fireEvent.change(input, { target: { files: [] } });
      expect(upload).not.toHaveBeenCalled();
      click.mockRestore();
    }
    const file = new File(["pixels"], "photo", { type: "image/jpeg" });
    await user.upload(gallery, [file, file]);
    await vi.waitFor(() => expect(composer).toBeEnabled());
    expect(composer.value).toBe('before "/tmp/photo space.jpg" "/tmp/photo space.jpg" after');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]![0].name).toBe("photo.jpg");
    expect(gallery.value).toBe("");
    await user.click(screen.getByRole("button", { name: "Attach images" }));
    await user.click(screen.getByRole("menuitem", { name: "Take photo" }));
    await user.upload(camera, file);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  it("rejects picker returns while busy or disconnected and disables attachments", async () => {
    const { api } = await import("../../src/client/api/client");
    const upload = vi.spyOn(api, "upload");
    const handlers = props(interaction("connected"));
    const view = render(<InteractionPanel {...handlers} />);
    const camera = screen.getByLabelText("Take photo");
    view.rerender(<InteractionPanel {...handlers} interactionBusy />);
    expect(screen.getByRole("button", { name: "Attach images" })).toBeDisabled();
    fireEvent.change(camera, { target: { files: [new File(["x"], "a.jpg")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Session is busy");
    view.rerender(<InteractionPanel {...handlers} interaction={interaction("disconnected")} />);
    fireEvent.change(camera, { target: { files: [new File(["x"], "a.jpg")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Reconnect");
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  it("shares limits, failures, upload locking and session aborts with other upload sources", async () => {
    const { api } = await import("../../src/client/api/client");
    const upload = vi.spyOn(api, "upload").mockRejectedValueOnce(new Error("Storage unavailable"));
    const view = render(<InteractionPanel {...props(interaction("connected"))} key="first" />);
    const camera = screen.getByLabelText("Take photo");
    const file = new File(["x"], "a.jpg");
    Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 + 1 });
    fireEvent.change(camera, { target: { files: [file] } });
    expect(screen.getByRole("alert")).toHaveTextContent("20 MiB");
    expect(upload).not.toHaveBeenCalled();
    fireEvent.change(camera, { target: { files: [new File(["x"], "a.jpg")] } });
    await screen.findByText("Storage unavailable");
    let finish!: (result: { path: string }) => void;
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.change(camera, { target: { files: [new File(["x"], "a.jpg")] } });
    expect(screen.getByRole("button", { name: "Attach images" })).toBeDisabled();
    const signal = upload.mock.calls[1]![1];
    view.rerender(<InteractionPanel {...props(interaction("connected"))} key="second" />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ path: "/tmp/old.jpg" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    upload.mockRestore();
  });
});

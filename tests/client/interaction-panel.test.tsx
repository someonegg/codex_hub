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
    onRebind: vi.fn().mockResolvedValue(undefined),
    onExpandPreview: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onSendKeys: vi.fn().mockResolvedValue(undefined),
    preview: null,
    previewBusy: false,
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
  it("shows the composer immediately when connected", () => {
    render(<InteractionPanel {...props(interaction("connected"))} />);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeVisible();
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
      { supported: true, state: "unknown", attachCommand: null },
      interaction("unbound"),
      null,
      { supported: false, attachCommand: null },
    ];
    for (const state of states) {
      view.rerender(<InteractionPanel {...handlers} interaction={state} />);
      expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("draft");
      expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    }
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    view.rerender(<InteractionPanel {...handlers} />);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("draft");
  });

  it("hides unbound and disconnected targets", () => {
    const view = render(<InteractionPanel {...props(interaction("unbound"))} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<InteractionPanel {...props(interaction("disconnected"))} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("keeps unsupported sessions read-only", () => {
    const { container, rerender } = render(<InteractionPanel {...props(null)} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<InteractionPanel {...props({ supported: false, attachCommand: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the event count and local update time while connected", () => {
    const updatedAt = "2026-08-08T12:00:00.000Z";
    const localTime = new Date(updatedAt).toLocaleTimeString(undefined, { timeStyle: "medium" });
    render(
      <InteractionPanel
        {...props(interaction("connected"))}
        itemCount={12}
        updatedAt={updatedAt}
      />,
    );

    const summary = screen.getByText(`12 events · Updated ${localTime}`);
    const preview = screen.getByRole("region", { name: "Terminal preview" });
    const prompt = screen.getByRole("textbox", { name: "Message to agent" });
    const lastAction = screen.getByRole("button", { name: "Interrupt" });
    expect(summary).toBeInTheDocument();
    expect(preview.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      lastAction.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      preview.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("uses a singular event label and falls back when the update time is unavailable", () => {
    const { rerender } = render(
      <InteractionPanel {...props(interaction("connected"))} itemCount={1} updatedAt={null} />,
    );
    expect(screen.getByText("1 event · Update time unavailable")).toBeInTheDocument();

    rerender(
      <InteractionPanel
        {...props(interaction("connected"))}
        itemCount={0}
        updatedAt="not-a-time"
      />,
    );
    expect(screen.getByText("0 events · Update time unavailable")).toBeInTheDocument();
  });

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
    expect(screen.getByRole("button", { name: "Terminal preview" })).toBeEnabled();
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
    expect(screen.getByRole("button", { name: "Terminal preview" })).not.toHaveAttribute(
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

  it("loads from the unified header and opens at the bottom", async () => {
    const handlers = props(interaction("connected"));
    const captured = {
      content: "first\nlatest",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(480);
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);

    const header = screen.getByRole("button", { name: "Terminal preview" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(handlers.onTogglePreview).toHaveBeenCalledTimes(1);

    rerender(<InteractionPanel {...handlers} preview={captured} />);
    expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const content = screen.getByLabelText("Terminal preview content");
    expect(content).toHaveAttribute("tabindex", "0");
    expect(content.scrollTop).toBe(480);
    scrollHeight.mockRestore();
  });

  it("renders a truncated terminal preview as plain text", () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "\u001b[31mplain text<img src=x onerror=alert(1)><script>alert(2)</script>",
        truncated: true,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    render(<InteractionPanel {...handlers} />);

    const content = screen.getByLabelText("Terminal preview content");
    expect(content).toHaveTextContent(
      "plain text<img src=x onerror=alert(1)><script>alert(2)</script>",
    );
    expect(content.querySelector("img")).toBeNull();
    expect(content.querySelector("script")).toBeNull();
    expect(screen.getByText(/terminal output exceeded the preview limit/i)).toBeInTheDocument();
  });

  it("reopens a folded terminal preview at the bottom", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "terminal output",
        truncated: false,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(640);
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);

    const header = screen.getByRole("button", { name: "Terminal preview" });
    await user.click(header);
    expect(screen.queryByLabelText("Terminal preview content")).not.toBeInTheDocument();
    await user.click(header);
    expect(screen.getByLabelText("Terminal preview content").scrollTop).toBe(640);
    scrollHeight.mockRestore();
  });

  it("replaces long terminal content without replacing or disturbing the scroll container", () => {
    const staleLine = "stale offscreen line";
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: Array.from({ length: 80 }, (_, index) => `${staleLine} ${index + 1}`).join("\n"),
        truncated: false,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const content = screen.getByLabelText("Terminal preview content");
    const textLayer = content.querySelector(".terminal-preview-content");
    expect(textLayer).not.toBeNull();
    content.scrollTop = 120;
    content.focus();
    expect(content).toHaveFocus();
    const refreshedPreview = {
      ...handlers.preview,
      content: "short fresh output",
      capturedAt: "2026-08-08T12:00:01.000Z",
    };
    rerender(<InteractionPanel {...handlers} preview={refreshedPreview} />);
    const refreshed = screen.getByLabelText("Terminal preview content");
    const refreshedTextLayer = refreshed.querySelector(".terminal-preview-content");
    expect(refreshed).toBe(content);
    expect(refreshedTextLayer).not.toBe(textLayer);
    expect(refreshedTextLayer).toHaveTextContent("short fresh output");
    expect(refreshed).not.toHaveTextContent(staleLine);
    expect(refreshed.scrollTop).toBe(120);
    expect(refreshed).toHaveFocus();
  });

  it("has no automatic refresh switch", () => {
    render(<InteractionPanel {...props(interaction("connected"))} />);
    expect(screen.queryByRole("switch", { name: "Auto refresh" })).toBeNull();
  });

  it("sends the six terminal keys from the rectangular terminal keypad", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" },
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

it("shows tmux access only when supplied and supports copy failure and focus return", async () => {
  const command = "tmux -S '/tmp/socket path' attach-session -t 'test'";
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<InteractionPanel {...props(interaction("connected"))} />);
  expect(screen.queryByRole("button", { name: "tmux access" })).not.toBeInTheDocument();
  view.rerender(
    <InteractionPanel {...props({ ...interaction("connected"), attachCommand: command })} />,
  );
  const trigger = screen.getByRole("button", { name: "tmux access" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "tmux access" })).toBeVisible();
  expect(screen.getByText(command).tagName).toBe("PRE");
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  fireEvent.click(screen.getByRole("button", { name: "Close tmux access" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("copies commands and closes on Escape, command withdrawal, and session replacement", async () => {
  const command = "tmux attach-session -t test";
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const connected = props({ ...interaction("connected"), attachCommand: command });
  const view = render(<InteractionPanel key="first" {...connected} />);
  const open = () => {
    const trigger = screen.getByRole("button", { name: "tmux access" });
    trigger.focus();
    fireEvent.click(trigger);
  };
  open();
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith(command);
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "tmux access" })).toHaveFocus();
  open();
  view.rerender(<InteractionPanel key="first" {...props(interaction("disconnected"))} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(<InteractionPanel key="first" {...connected} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  open();
  view.rerender(<InteractionPanel key="second" {...connected} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  ["/plan", true],
  [" /STATUS ", true],
  ["/plan now", false],
  ["/foo-bar", false],
  ["/abc1", false],
  ["/中文", false],
  ["hello", false],
])("expands the preview after successfully sending %s: %s", async (message, expands) => {
  const handlers = props(interaction("connected"));
  render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: message } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
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
  const toggle = screen.getByRole("button", { name: "Terminal preview" });
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
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByRole("textbox")).toHaveValue("/plan");
});

it("rebinds without changing the draft or preview and disables rebind while busy or disconnected", async () => {
  const handlers = props(interaction("connected"));
  const view = render(<InteractionPanel {...handlers} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Rebind" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(handlers.onRebind).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox")).toHaveValue("draft");
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  view.rerender(<InteractionPanel {...handlers} interactionBusy />);
  expect(screen.getByRole("button", { name: "Rebind" })).toBeDisabled();
  view.rerender(<InteractionPanel {...handlers} interaction={interaction("disconnected")} />);
  expect(screen.getByRole("button", { name: "Rebind" })).toBeDisabled();
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

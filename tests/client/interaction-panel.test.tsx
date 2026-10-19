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
    const toggle = screen.getByRole("button", { name: "Terminal preview" });
    await user.click(toggle);
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
      behavior: "instant",
    });
    await user.keyboard("{Escape}");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).not.toHaveFocus();
  });

  it("aligns an expanded panel taller than the viewport to the bottom", async () => {
    const user = userEvent.setup();
    render(<InteractionPanel {...props(interaction("connected"))} />);
    const panel = screen.getByRole("region", { name: "Session interaction" });
    const scrollIntoView = vi.fn();
    panel.scrollIntoView = scrollIntoView;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 390, window.innerHeight + 100),
    );
    await user.click(screen.getByRole("button", { name: "Terminal preview" }));
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "end", behavior: "instant" });
  });

  it("reveals the first nonempty output after an empty capture only once", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const panel = screen.getByRole("region", { name: "Session interaction" });
    const scrollIntoView = vi.fn();
    panel.scrollIntoView = scrollIntoView;
    await user.click(screen.getByRole("button", { name: "Terminal preview" }));
    const empty = {
      content: "",
      truncated: false,
      revision: "r".repeat(43),
      capturedAt: "2026-08-08",
    };
    rerender(<InteractionPanel {...handlers} preview={empty} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<InteractionPanel {...handlers} preview={{ ...empty, content: "first output" }} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    rerender(<InteractionPanel {...handlers} preview={{ ...empty, content: "new output" }} />);
    rerender(<InteractionPanel {...handlers} preview={empty} />);
    rerender(<InteractionPanel {...handlers} preview={{ ...empty, content: "more output" }} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("focuses the preview once on expansion, including before output arrives", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const toggle = screen.getByRole("button", { name: "Terminal preview" });
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
      { supported: true, supersededBySessionId: null, state: "unknown", attachCommand: null },
      interaction("unbound"),
      null,
      { supported: false, attachCommand: null },
    ];
    for (const state of states) {
      view.rerender(<InteractionPanel {...handlers} interaction={state} />);
      expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Terminal preview" })).not.toBeInTheDocument();
    }
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    view.rerender(<InteractionPanel {...handlers} />);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("draft");
  });

  it("shows simplified panels for unbound and disconnected targets", () => {
    const view = render(<InteractionPanel {...props(interaction("unbound"))} />);
    expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    view.rerender(<InteractionPanel {...props(interaction("disconnected"))} />);
    expect(screen.getByRole("region", { name: "Session interaction" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps unsupported sessions read-only", () => {
    const { container, rerender } = render(<InteractionPanel {...props(null)} />);
    expect(container.querySelector("textarea")).toBeNull();
    rerender(<InteractionPanel {...props({ supported: false, attachCommand: null })} />);
    expect(container.querySelector("textarea")).toBeNull();
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
    const lastAction = screen.getByRole("button", { name: "Plan" });
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
    expect(screen.getByRole("button", { name: "Plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" }).parentElement).toHaveClass(
      "interaction-primary-actions",
    );
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal preview" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(handlers.onSendKeys).toHaveBeenNthCalledWith(1, ["plan"]);
    expect(handlers.onSendKeys).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox"), "draft");
    const interrupt = screen.getByRole("button", { name: "Plan" });
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
      revision: "r".repeat(43),
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
        revision: "r".repeat(43),
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
        revision: "r".repeat(43),
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
        revision: "r".repeat(43),
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
      revision: "r".repeat(43),
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
      "^C",
      "←",
      "↓",
      "→",
    ]);

    for (const name of ["Enter", "Up", "Interrupt", "Left", "Down", "Right"]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(handlers.onSendKeys.mock.calls).toEqual([
      [["enter"]],
      [["up"]],
      [["interrupt"]],
      [["left"]],
      [["down"]],
      [["right"]],
    ]);

    rerender(<InteractionPanel {...handlers} interactionBusy />);
    handlers.onSendKeys.mockClear();
    for (const name of ["Enter", "Up", "Interrupt", "Left", "Down", "Right"]) {
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
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
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
  for (const name of ["Send", "Handoff", "Plan", "Terminal preview"])
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  view.rerender(<InteractionPanel {...props(interaction("connected"))} />);
  expect(screen.getByRole("textbox")).toHaveValue("draft");
});

it("shows the takeover even on first load, with no link when its session is missing", () => {
  render(
    <InteractionPanel
      {...props({
        supported: true,
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
  const toggle = screen.getByRole("button", { name: "Terminal preview" });
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
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it.each([
  ["Enter", "enter"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
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
});

it("preserves editing and unrelated keyboard actions and blocks sends while busy or folded", () => {
  const handlers = props(interaction("connected"));
  const view = render(<Panel {...handlers} previewExpanded />);
  const body = screen.getByRole("group", { name: "Terminal controls" }).parentElement!;
  for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey", "isComposing"]) {
    expect(fireEvent.keyDown(body, { key: "Enter", [modifier]: true })).toBe(true);
  }
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" })).toBe(true);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Terminal preview" }), { key: "Enter" }),
  ).toBe(true);
  expect(handlers.onSendKeys).not.toHaveBeenCalled();
  fireEvent.click(body);
  expect(body).toHaveFocus();
  view.rerender(<Panel {...handlers} interactionBusy previewExpanded />);
  expect(fireEvent.keyDown(body, { key: "Enter" })).toBe(false);
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

it("places Plan beside Send, expands on click, and keeps the interrupt compact without a tooltip", () => {
  const handlers = props(interaction("connected"));
  render(<InteractionPanel {...handlers} />);
  const plan = screen.getByRole("button", { name: "Plan" });
  expect(plan.parentElement).toBe(screen.getByRole("button", { name: "Send" }).parentElement);
  fireEvent.click(plan);
  expect(handlers.onSendKeys).toHaveBeenCalledExactlyOnceWith(["plan"]);
  expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const interrupt = screen.getByRole("button", { name: "Interrupt" });
  expect(interrupt).toHaveTextContent("^C");
  expect(interrupt).not.toHaveAttribute("title");
  expect(interrupt.closest(".terminal-keypad")).not.toBeNull();
});

it("places tmux access before Exit in the connected heading and keeps operation output in the panel", () => {
  render(
    <InteractionPanel
      {...props({ ...interaction("connected"), attachCommand: "tmux attach" })}
      operationActions={<button>Exit</button>}
      operationStatus={<p>Waiting for exit</p>}
    />,
  );
  const access = screen.getByRole("button", { name: "tmux access" });
  const exit = screen.getByRole("button", { name: "Exit" });
  expect(access.closest(".interaction-heading")).toBe(exit.closest(".interaction-heading"));
  expect(access.compareDocumentPosition(exit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("region", { name: "Session interaction" })).toContainElement(
    screen.getByText("Waiting for exit"),
  );
});

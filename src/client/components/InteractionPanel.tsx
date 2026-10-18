import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewResponse,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";

import { InternalLink } from "./InternalLink";
import { TmuxAccessDialog } from "./TmuxAccessDialog";

interface InteractionPanelProps {
  interaction: InteractionResponse | null;
  onNavigate?: (sessionId: string) => void;
  itemCount: number;
  updatedAt: string | null;
  interactionBusy: boolean;
  error: string | null;
  onDismissError: () => void;
  onHandoffPaneBinding: () => Promise<void>;
  onExpandPreview: () => void;
  onSendMessage: (message: string) => Promise<void>;
  onSendKeys: (keys: readonly InteractionKey[]) => Promise<void>;
  preview: TerminalPreviewResponse | null;
  previewBusy: boolean;
  previewError: string | null;
  onDismissPreviewError: () => void;
  previewExpanded: boolean;
  onTogglePreview: () => void;
}

export function InteractionPanel({
  interaction,
  onNavigate,
  itemCount,
  updatedAt,
  interactionBusy,
  error,
  onDismissError,
  onSendMessage,
  onHandoffPaneBinding,
  onExpandPreview,
  onSendKeys,
  preview,
  previewBusy,
  previewError,
  onDismissPreviewError,
  previewExpanded,
  onTogglePreview,
}: InteractionPanelProps) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [accessOpen, setAccessOpen] = useState(false);
  const attachCommand = interaction?.attachCommand;
  useEffect(() => {
    if (!attachCommand) setAccessOpen(false);
  }, [attachCommand]);
  const [hasShown, setHasShown] = useState(false);
  const [message, setMessage] = useState("");
  const previewContentId = useId();
  const previewContent = useRef<HTMLPreElement | null>(null);
  const scrollOnExpand = useRef(true);
  const messageBytes = new TextEncoder().encode(message.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  const messageIsBlank = message.trim().length === 0;
  const previewConnected = interaction?.supported === true && interaction.state === "connected";
  useEffect(() => {
    if (previewConnected) setHasShown(true);
  }, [previewConnected]);
  useLayoutEffect(() => {
    if (!previewExpanded) {
      scrollOnExpand.current = true;
      return;
    }
    if (preview === null) return;
    const content = previewContent.current;
    if (content === null) return;
    if (scrollOnExpand.current) {
      content.scrollTop = content.scrollHeight;
      scrollOnExpand.current = false;
    }
  }, [preview, previewExpanded]);
  if (
    !hasShown &&
    !previewConnected &&
    !(interaction?.supported && interaction.state === "superseded")
  )
    return null;

  const send = async () => {
    if (!previewConnected || interactionBusy || messageIsBlank || messageTooLarge) return;
    const isCommand = /^\/[A-Za-z]+$/.test(message.trim());
    await onSendMessage(message);
    if (!mounted.current) return;
    if (isCommand) {
      if (!previewExpanded) scrollOnExpand.current = true;
      onExpandPreview();
    }
    setMessage("");
  };
  const handoff = async () => {
    if (!previewConnected || interactionBusy) return;
    await onHandoffPaneBinding();
    if (!mounted.current) return;
    if (!previewExpanded) scrollOnExpand.current = true;
    onExpandPreview();
  };
  const sendKeys = (keys: readonly InteractionKey[]) => {
    if (!previewConnected || interactionBusy) return;
    if (keys.includes("plan")) {
      if (!previewExpanded) scrollOnExpand.current = true;
      onExpandPreview();
    }
    void onSendKeys(keys).catch(() => undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send().catch(() => undefined);
  };
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !previewExpanded ||
      !previewConnected ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    const key = PREVIEW_KEYS[event.key];
    if (!key) return;
    event.preventDefault();
    sendKeys([key]);
  };
  const status = interactionStatus(
    interaction?.supported ? interaction.state : "unavailable",
    error,
    previewError,
  );
  const togglePreview = () => {
    if (!previewExpanded) scrollOnExpand.current = true;
    onTogglePreview();
  };

  return (
    <section className="interaction-panel" aria-label="Session interaction">
      <div className="interaction-heading">
        <span className={`interaction-status interaction-status-${status.kind}`}>
          {status.label}
        </span>
        {interaction?.supported && interaction.state === "superseded" ? (
          interaction.supersededBySessionId ? (
            <InternalLink
              href={`/sessions/${encodeURIComponent(interaction.supersededBySessionId)}`}
              onNavigate={
                onNavigate ? () => onNavigate(interaction.supersededBySessionId!) : undefined
              }
            >
              Go to bound session
            </InternalLink>
          ) : (
            <span>Replacement session unavailable</span>
          )
        ) : null}
        {attachCommand ? (
          <button type="button" className="tmux-access-trigger" onClick={() => setAccessOpen(true)}>
            tmux access
          </button>
        ) : null}
      </div>
      {accessOpen && attachCommand ? (
        <TmuxAccessDialog command={attachCommand} onClose={() => setAccessOpen(false)} />
      ) : null}
      <div className="interaction-panel-content">
        {error ? (
          <div className="interaction-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onDismissError} aria-label="Dismiss interaction error">
              ×
            </button>
          </div>
        ) : null}
        {renderConnectedInteraction()}
        <p className="interaction-summary">{sessionSummary(itemCount, updatedAt)}</p>
      </div>
    </section>
  );

  function renderConnectedInteraction() {
    return (
      <>
        <section className="terminal-preview" aria-label="Terminal preview">
          <div className="terminal-preview-header">
            <button
              type="button"
              className="terminal-preview-toggle"
              aria-expanded={previewExpanded}
              aria-controls={previewContentId}
              onClick={togglePreview}
              disabled={!previewConnected}
            >
              <span className="terminal-preview-mark" aria-hidden="true">
                {preview !== null && previewExpanded ? "▾" : "▸"}
              </span>
              <span>Terminal preview</span>
              {preview === null && previewBusy ? (
                <span className="terminal-preview-status">Capturing…</span>
              ) : null}
            </button>
          </div>
          {previewError ? (
            <div className="interaction-error terminal-preview-error" role="alert">
              <span>{previewError}</span>
              <button
                type="button"
                onClick={onDismissPreviewError}
                aria-label="Dismiss terminal preview error"
              >
                ×
              </button>
            </div>
          ) : null}
          {previewExpanded ? (
            <div
              id={previewContentId}
              className="terminal-preview-body"
              tabIndex={0}
              onKeyDown={onPreviewKeyDown}
              onClick={(event) => {
                if (!(event.target instanceof Element) || !event.target.closest("button, pre"))
                  event.currentTarget.focus();
              }}
            >
              {preview?.truncated ? (
                <p className="terminal-preview-notice">
                  Terminal output exceeded the preview limit; the beginning was omitted.
                </p>
              ) : null}
              {preview && preview.content.length > 0 ? (
                <pre ref={previewContent} aria-label="Terminal preview content" tabIndex={0}>
                  <span key={preview.capturedAt} className="terminal-preview-content">
                    {preview.content}
                  </span>
                </pre>
              ) : (
                <p className="terminal-preview-empty">
                  {preview === null && previewBusy
                    ? "Capturing terminal pane…"
                    : preview === null
                      ? "Terminal preview unavailable."
                      : "The terminal pane is empty."}
                </p>
              )}
              <div className="terminal-keypad" role="group" aria-label="Terminal controls">
                {TERMINAL_CONTROL_KEYS.map(({ key, label, glyph }) => (
                  <button
                    key={key}
                    type="button"
                    className={`terminal-key terminal-key-${key}`}
                    aria-label={label}
                    disabled={!previewConnected}
                    aria-disabled={interactionBusy || !previewConnected}
                    onClick={() => sendKeys([key])}
                  >
                    <span aria-hidden="true">{glyph}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
        <div className="interaction-composer">
          <textarea
            aria-label="Message to agent"
            value={message}
            disabled={interactionBusy || !previewConnected}
            rows={3}
            maxLength={MAX_INTERACTION_MESSAGE_BYTES}
            placeholder="Send a prompt… Enter for a new line, Shift+Enter to send"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {messageTooLarge ? (
            <p className="interaction-message-limit" role="alert">
              Message is {messageBytes.toLocaleString()} UTF-8 bytes; the limit is{" "}
              {MAX_INTERACTION_MESSAGE_BYTES.toLocaleString()} bytes.
            </p>
          ) : null}
          <div className="interaction-actions">
            <div className="interaction-primary-actions">
              <button
                type="button"
                className="interaction-send"
                disabled={!previewConnected || messageIsBlank || messageTooLarge}
                aria-disabled={interactionBusy}
                onClick={() => void send().catch(() => undefined)}
              >
                Send
              </button>
              <button
                type="button"
                disabled={!previewConnected}
                aria-disabled={interactionBusy}
                onClick={() => sendKeys(["plan"])}
              >
                Plan
              </button>
            </div>
            <button
              type="button"
              className="interaction-handoff"
              title="Hand off this pane’s binding to the active Codex session."
              disabled={!previewConnected || interactionBusy}
              onClick={() => void handoff().catch(() => undefined)}
            >
              Handoff
            </button>
          </div>
        </div>
      </>
    );
  }
}

function interactionStatus(
  state: "unbound" | "disconnected" | "connected" | "unknown" | "unavailable" | "superseded",
  error: string | null,
  previewError: string | null,
): { kind: "error" | "warning" | "connected"; label: string } {
  if (state === "superseded") return { kind: "warning", label: "Superseded" };
  if (error !== null || previewError !== null) return { kind: "error", label: "Error" };
  if (state === "disconnected") return { kind: "warning", label: "Disconnected" };
  if (state === "unbound") return { kind: "warning", label: "Unbound" };
  if (state === "unknown") return { kind: "warning", label: "Connection unknown" };
  if (state === "unavailable") return { kind: "warning", label: "Unavailable" };
  return { kind: "connected", label: "Connected" };
}

const PREVIEW_KEYS: Readonly<Record<string, InteractionKey | undefined>> = {
  Enter: "enter",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const TERMINAL_CONTROL_KEYS: ReadonlyArray<{
  readonly key: Extract<InteractionKey, "up" | "down" | "left" | "right" | "enter" | "interrupt">;
  readonly label: string;
  readonly glyph: string;
}> = [
  { key: "enter", label: "Enter", glyph: "Enter" },
  { key: "up", label: "Up", glyph: "↑" },
  { key: "interrupt", label: "Interrupt", glyph: "^C" },
  { key: "left", label: "Left", glyph: "←" },
  { key: "down", label: "Down", glyph: "↓" },
  { key: "right", label: "Right", glyph: "→" },
];

function sessionSummary(itemCount: number, updatedAt: string | null): string {
  const eventLabel = `${itemCount} ${itemCount === 1 ? "event" : "events"}`;
  if (updatedAt === null) return `${eventLabel} · Update time unavailable`;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.valueOf())) return `${eventLabel} · Update time unavailable`;
  return `${eventLabel} · Updated ${date.toLocaleTimeString(undefined, { timeStyle: "medium" })}`;
}

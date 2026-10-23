import type { ReactNode } from "react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewSnapshot,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";
import { MAX_UPLOAD_BYTES } from "../../shared/uploads";

import { api } from "../api/client";
import { InternalLink } from "./InternalLink";
import { TmuxAccessDialog } from "./TmuxAccessDialog";

interface InteractionPanelProps {
  operationActions?: ReactNode;
  operationStatus?: ReactNode;

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
  preview: TerminalPreviewSnapshot | null;
  previewBusy: boolean;
  previewStopped: boolean;
  onRetryPreview: () => void;
  previewError: string | null;
  onDismissPreviewError: () => void;
  previewExpanded: boolean;
  onTogglePreview: () => void;
}

export function InteractionPanel({
  operationActions,
  operationStatus,
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
  previewStopped,
  onRetryPreview,
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
  const [message, setMessage] = useState("");
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const upload = useRef<AbortController | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => upload.current?.abort(), []);
  const uploadFiles = async (files: File[]) => {
    if (!files.length || upload.current || interactionBusy || !previewConnected) return;
    setDragging(false);
    setUploadError(null);
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setUploadError("Files must be at most 20 MiB");
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    let text = message;
    let caret = composer.current?.selectionStart ?? message.length;
    let selectionEnd = composer.current?.selectionEnd ?? caret;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress(`Uploading ${index + 1}/${files.length}…`);
        const result = await api.upload(file, controller.signal);
        if (controller.signal.aborted) return;
        const path = /[\s"'\\]/.test(result.path) ? JSON.stringify(result.path) : result.path;
        const before = text.slice(0, caret);
        const after = text.slice(selectionEnd);
        const insertion = (before && !/\s$/.test(before) ? " " : "") + path;
        const suffix = after && !/^\s/.test(after) ? " " : "";
        text = before + insertion + suffix + after;
        caret = before.length + insertion.length;
        selectionEnd = caret;
        setMessage(text);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      if (!controller.signal.aborted) {
        upload.current = null;
        setUploadProgress(null);
        requestAnimationFrame(() => {
          if (!mounted.current) return;
          composer.current?.focus();
          composer.current?.setSelectionRange(caret, caret);
        });
      }
    }
  };
  const panel = useRef<HTMLElement | null>(null);
  const wasPreviewExpanded = useRef(false);
  const hadPreviewContent = useRef(false);
  const previewContentId = useId();
  const previewBody = useRef<HTMLDivElement | null>(null);
  const previewToggle = useRef<HTMLButtonElement | null>(null);
  const previewContent = useRef<HTMLPreElement | null>(null);
  const scrollOnExpand = useRef(true);
  const messageBytes = new TextEncoder().encode(message.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  const messageIsBlank = message.trim().length === 0;
  const previewConnected = interaction?.supported === true && interaction.state === "connected";
  const previewHasContent = (preview?.content.length ?? 0) > 0;
  useLayoutEffect(() => {
    if (previewExpanded && previewConnected) previewBody.current?.focus({ preventScroll: true });
  }, [previewExpanded, previewConnected]);
  useLayoutEffect(() => {
    const expanded = previewExpanded && previewConnected;
    const firstContent = expanded && previewHasContent && !hadPreviewContent.current;
    if (expanded !== wasPreviewExpanded.current || firstContent) {
      const element = panel.current;
      element?.scrollIntoView?.({
        block: element.getBoundingClientRect().height > window.innerHeight ? "end" : "nearest",
        behavior: "instant",
      });
    }
    wasPreviewExpanded.current = expanded;
    hadPreviewContent.current = expanded && (hadPreviewContent.current || previewHasContent);
  }, [previewExpanded, previewConnected, previewHasContent]);
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
  const send = async () => {
    if (!previewConnected || interactionBusy || upload.current || messageIsBlank || messageTooLarge)
      return;
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
    if (!previewConnected || interactionBusy || upload.current) return;
    await onHandoffPaneBinding();
    if (!mounted.current) return;
    if (!previewExpanded) scrollOnExpand.current = true;
    onExpandPreview();
  };
  const sendKeys = (keys: readonly InteractionKey[]) => {
    if (!previewConnected || interactionBusy) return;
    if (keys.includes("interrupt")) {
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
    if (event.key === "Escape") {
      event.preventDefault();
      if (!interactionBusy) {
        onTogglePreview();
        previewToggle.current?.focus({ preventScroll: true });
      }
      return;
    }
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
  const statusLabel = (
    <span className={`interaction-status interaction-status-${status.kind}`}>{status.label}</span>
  );
  const connectionStatus =
    interaction?.supported && interaction.state === "unbound" ? (
      <div className="interaction-connection-status">
        {statusLabel}
        <span className="resume-reason">Ensure the original session has exited.</span>
      </div>
    ) : (
      statusLabel
    );
  const togglePreview = () => {
    if (!previewExpanded) scrollOnExpand.current = true;
    onTogglePreview();
  };

  return (
    <section ref={panel} className="interaction-panel" aria-label="Session interaction">
      <div className="interaction-heading">
        {attachCommand ? (
          <button type="button" className="tmux-access-trigger" onClick={() => setAccessOpen(true)}>
            tmux access
          </button>
        ) : null}
        {status.kind !== "connected" ? connectionStatus : null}
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
        <div className="interaction-management-actions">{operationActions}</div>
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
        {operationStatus}
        {previewConnected ? renderConnectedInteraction() : null}
        <p className="interaction-summary">{sessionSummary(itemCount, updatedAt)}</p>
      </div>
    </section>
  );

  function renderConnectedInteraction() {
    return (
      <>
        <section className="terminal-preview" aria-label="Terminal Preview">
          <div className="terminal-preview-header">
            <button
              type="button"
              className="terminal-preview-toggle"
              ref={previewToggle}
              aria-expanded={previewExpanded}
              aria-label="Terminal Preview"
              aria-controls={previewContentId}
              onClick={togglePreview}
              disabled={!previewConnected}
            >
              <span className="terminal-preview-mark" aria-hidden="true">
                {preview !== null && previewExpanded ? "▾" : "▸"}
              </span>
              <span>Terminal Preview</span>
              {interaction?.supported &&
              (interaction.activity === "working" || interaction.activity === "idle") ? (
                <span
                  className={`terminal-activity terminal-activity-${interaction.activity}`}
                  role="status"
                >
                  <span className="terminal-activity-dot" aria-hidden="true" />
                  {interaction.activity === "working" ? "Working" : "Idle"}
                </span>
              ) : null}
              {preview === null && previewBusy ? (
                <span className="terminal-preview-status">Capturing…</span>
              ) : null}
            </button>
          </div>
          {previewStopped ? (
            <div className="terminal-preview-notice" role="status">
              <span>Preview updates stopped.</span>{" "}
              <button type="button" onClick={onRetryPreview} disabled={previewBusy}>
                {previewBusy ? "Reconnecting…" : "Retry preview"}
              </button>
            </div>
          ) : null}
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
              ref={previewBody}
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
                <pre ref={previewContent} aria-label="Terminal Preview content" tabIndex={0}>
                  <span key={preview.capturedAt} className="terminal-preview-content">
                    {preview.content}
                  </span>
                </pre>
              ) : (
                <p className="terminal-preview-empty">
                  {preview === null && previewBusy
                    ? "Capturing terminal pane…"
                    : preview === null
                      ? "Terminal Preview unavailable."
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
                    aria-disabled={interactionBusy || !!uploadProgress || !previewConnected}
                    onClick={() => sendKeys([key])}
                  >
                    <span aria-hidden="true">{glyph}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
        <div
          className={`interaction-composer${dragging ? " interaction-composer-dragging" : ""}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = upload.current || interactionBusy ? "none" : "copy";
            setDragging(!upload.current && !interactionBusy);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (
              !event.dataTransfer.files.length &&
              !Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file")
            )
              return;
            event.preventDefault();
            setDragging(false);
            const items = Array.from(event.dataTransfer.items ?? []);
            if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
              if (!upload.current) setUploadError("Folders are not supported");
              return;
            }
            void uploadFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {dragging ? <p role="status">Drop files to upload</p> : null}
          {uploadProgress ? <p role="status">{uploadProgress}</p> : null}
          {uploadError ? (
            <div className="interaction-error" role="alert">
              {uploadError}
              <button
                type="button"
                aria-label="Dismiss upload error"
                onClick={() => setUploadError(null)}
              >
                ×
              </button>
            </div>
          ) : null}
          <textarea
            ref={composer}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault();
              void uploadFiles(files.map(normalizeClipboardFile));
            }}
            aria-label="Message to agent"
            value={message}
            disabled={interactionBusy || !!uploadProgress || !previewConnected}
            rows={5}
            maxLength={MAX_INTERACTION_MESSAGE_BYTES}
            placeholder="Send a prompt… Paste images or drop files. Shift+Enter to send"
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
            <div className="interaction-secondary-actions">
              <button
                type="button"
                className="interaction-handoff"
                title="Hand off this pane’s binding to the active Codex session."
                disabled={!previewConnected || interactionBusy || !!uploadProgress}
                onClick={() => void handoff().catch(() => undefined)}
              >
                Handoff
              </button>
              <button
                type="button"
                className="interaction-interrupt"
                disabled={!previewConnected}
                aria-disabled={interactionBusy || !!uploadProgress || !previewConnected}
                onClick={() => sendKeys(["interrupt"])}
              >
                Interrupt
              </button>
            </div>
            <div className="interaction-primary-actions">
              <button
                type="button"
                className="interaction-send"
                disabled={
                  !previewConnected || !!uploadProgress || messageIsBlank || messageTooLarge
                }
                aria-disabled={interactionBusy}
                onClick={() => void send().catch(() => undefined)}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }
}

const CLIPBOARD_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/x-icon": "ico",
};

function normalizeClipboardFile(file: File): File {
  const extension = CLIPBOARD_IMAGE_EXTENSIONS[file.type];
  if (/\.[a-zA-Z0-9]{1,16}$/.test(file.name) || !extension) return file;
  return new File([file], `${file.name || "clipboard"}.${extension}`, { type: file.type });
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
  readonly key: Extract<InteractionKey, "up" | "down" | "left" | "right" | "enter" | "plan">;
  readonly label: string;
  readonly glyph: string;
}> = [
  { key: "enter", label: "Enter", glyph: "Enter" },
  { key: "up", label: "Up", glyph: "↑" },
  { key: "plan", label: "Plan", glyph: "Plan" },
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

import type { ReactNode } from "react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewSnapshot,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";
import { MAX_UPLOAD_BYTES } from "../../shared/uploads";

import { api } from "../api/client";
import { useSessionDraft } from "../state/session-drafts";
import { InternalLink } from "./InternalLink";

interface InteractionPanelProps {
  sessionId: string;
  onPanelElement?: (element: HTMLElement | null) => void;
  recoveryActions?: ReactNode;
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
  sessionId,
  onPanelElement,
  recoveryActions,
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
  const { message, setMessage, clearSentMessage } = useSessionDraft(sessionId);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const upload = useRef<AbortController | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => upload.current?.abort(), []);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const attachmentButton = useRef<HTMLButtonElement | null>(null);
  const attachmentMenu = useRef<HTMLDivElement | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const imagesInput = useRef<HTMLInputElement | null>(null);
  const savedSelection = useRef<{ start: number; end: number } | null>(null);
  const attachmentMenuId = useId();
  const openAttachments = () => {
    savedSelection.current = {
      start: composer.current?.selectionStart ?? message.length,
      end: composer.current?.selectionEnd ?? message.length,
    };
    setAttachmentsOpen(true);
  };
  const closeAttachments = (restoreFocus = true) => {
    setAttachmentsOpen(false);
    if (restoreFocus) attachmentButton.current?.focus();
  };
  const onAttachmentMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAttachments();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) closeAttachments();
      else {
        attachmentButton.current?.parentElement
          ?.querySelector<HTMLButtonElement>(".interaction-send")
          ?.focus();
        closeAttachments(false);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll("button"));
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      next = (index + direction + items.length) % items.length;
    }
    items[next]?.focus();
  };
  useEffect(() => {
    if (!attachmentsOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !attachmentMenu.current?.contains(event.target) &&
        !attachmentButton.current?.contains(event.target)
      )
        closeAttachments();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [attachmentsOpen]);
  useLayoutEffect(() => {
    if (!attachmentsOpen) return;
    const position = () => {
      const button = attachmentButton.current?.getBoundingClientRect();
      const menu = attachmentMenu.current;
      if (!button || !menu) return;
      const top = Math.min(window.innerHeight - 8, Math.max(12, button.top));
      const right = Math.min(
        Math.max(8, window.innerWidth - button.right),
        Math.max(8, window.innerWidth - menu.offsetWidth - 8),
      );
      menu.style.right = `${right}px`;
      menu.style.bottom = `${window.innerHeight - top + 4}px`;
      menu.style.maxHeight = `${Math.max(0, top - 12)}px`;
    };
    position();
    attachmentMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [attachmentsOpen]);
  const uploadFiles = async (files: File[], selection?: { start: number; end: number }) => {
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
    let caret = selection?.start ?? composer.current?.selectionStart ?? message.length;
    let selectionEnd = selection?.end ?? composer.current?.selectionEnd ?? caret;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress(`Uploading ${index + 1}/${files.length}…`);
        const result = await api.upload(normalizeImageFile(file), controller.signal);
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
  const setPanel = useCallback(
    (element: HTMLElement | null) => {
      panel.current = element;
      onPanelElement?.(element);
    },
    [onPanelElement],
  );
  const wasPreviewExpanded = useRef(false);
  const hadPreviewContent = useRef(false);
  const previewContentId = useId();
  const previewBody = useRef<HTMLDivElement | null>(null);
  const previewContent = useRef<HTMLPreElement | null>(null);
  const scrollOnExpand = useRef(true);
  const messageBytes = new TextEncoder().encode(message.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  const messageIsBlank = message.trim().length === 0;
  const previewConnected = interaction?.supported === true && interaction.state === "connected";
  useEffect(() => {
    if (interactionBusy || !previewConnected) setAttachmentsOpen(false);
  }, [interactionBusy, previewConnected]);
  const chooseFiles = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    if (!previewConnected || interactionBusy) {
      setUploadError(
        !previewConnected
          ? "Reconnect before attaching images"
          : "Session is busy; try again later",
      );
      return;
    }
    void uploadFiles(files, savedSelection.current ?? undefined);
  };
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
    clearSentMessage();
    if (!mounted.current) return;
    if (isCommand) {
      if (!previewExpanded) scrollOnExpand.current = true;
      onExpandPreview();
    }
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
    <section ref={setPanel} className="interaction-panel" aria-label="Session interaction">
      {status.kind !== "connected" || recoveryActions ? (
        <div className="interaction-heading">
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
          <div className="interaction-management-actions">{recoveryActions}</div>
        </div>
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
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-label="Take photo"
          onChange={(event) => chooseFiles(event.currentTarget)}
        />
        <input
          ref={imagesInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Choose images"
          onChange={(event) => chooseFiles(event.currentTarget)}
        />
        {!previewConnected && uploadError ? <p role="alert">{uploadError}</p> : null}
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
              void uploadFiles(files);
            }}
            aria-label="Message to agent"
            value={message}
            disabled={interactionBusy || !!uploadProgress || !previewConnected}
            rows={4}
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
                ref={attachmentButton}
                type="button"
                className="interaction-attach"
                aria-label="Attach images"
                aria-haspopup="menu"
                aria-expanded={attachmentsOpen}
                aria-controls={attachmentsOpen ? attachmentMenuId : undefined}
                disabled={!previewConnected || interactionBusy || !!uploadProgress}
                onClick={() => {
                  if (attachmentsOpen) closeAttachments();
                  else openAttachments();
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    openAttachments();
                  }
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M16 5h6M19 2v6" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m3 16 5-5 10 10m-5-5 3-3 5 5" />
                </svg>
              </button>
              {attachmentsOpen ? (
                <div
                  ref={attachmentMenu}
                  id={attachmentMenuId}
                  role="menu"
                  aria-label="Attach images"
                  className="interaction-attachment-menu"
                  onKeyDown={onAttachmentMenuKeyDown}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      photoInput.current?.click();
                      closeAttachments();
                    }}
                  >
                    Take photo
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      imagesInput.current?.click();
                      closeAttachments();
                    }}
                  >
                    Choose images
                  </button>
                </div>
              ) : null}
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

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
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

function normalizeImageFile(file: File): File {
  const extension = IMAGE_EXTENSIONS[file.type];
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
  Escape: "interrupt",
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

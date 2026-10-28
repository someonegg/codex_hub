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

import { useSessionDraft } from "../state/session-drafts";
import { useAttachmentUpload } from "../state/use-attachment-upload";
import { AttachmentList } from "./AttachmentList";
import { AttachmentMenu } from "./AttachmentMenu";
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
  const { message, setMessage, attachments, addAttachment, removeAttachment, clearSentMessage } =
    useSessionDraft(sessionId);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    composer.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [message]);
  const [dragging, setDragging] = useState(false);
  const previewConnected = interaction?.supported === true && interaction.state === "connected";
  const {
    uploadFiles: startUpload,
    uploadProgress,
    uploadError,
    setUploadError,
    isUploading,
  } = useAttachmentUpload(sessionId, previewConnected, interactionBusy, addAttachment);
  const uploadFiles = async (files: File[]) => {
    if (!files.length || isUploading() || interactionBusy || !previewConnected) return;
    setDragging(false);
    if (!(await startUpload(files))) return;
    requestAnimationFrame(() => {
      if (mounted.current) composer.current?.focus();
    });
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
  const paths = attachments.map(({ path }) =>
    /[\s"'\\]/.test(path) ? JSON.stringify(path) : path,
  );
  const outgoingMessage = paths.length
    ? paths.join("\n") + (message.length ? "\n\n" + message : "")
    : message;
  const messageBytes = new TextEncoder().encode(outgoingMessage.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  const messageIsBlank = !attachments.length && message.trim().length === 0;
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
  const isStrictSlashCommand = !attachments.length && /^\/[A-Za-z]+$/.test(message.trim());
  const send = async () => {
    if (!previewConnected || interactionBusy || isUploading() || messageIsBlank || messageTooLarge)
      return;
    const command = message.trim();
    const shouldExpandPreview = isStrictSlashCommand && command !== "/exit" && command !== "/quit";
    await onSendMessage(outgoingMessage);
    clearSentMessage();
    if (!mounted.current) return;
    if (shouldExpandPreview) {
      if (!previewExpanded) scrollOnExpand.current = true;
      onExpandPreview();
    }
  };
  const handoff = async () => {
    if (!previewConnected || interactionBusy || isUploading()) return;
    await onHandoffPaneBinding();
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
    if (event.nativeEvent.isComposing) return;
    const controlJ = isControlJ(event);
    if (event.key !== "Enter" && !controlJ) return;
    if (!event.shiftKey && !isStrictSlashCommand) {
      if (!controlJ) return;
      event.preventDefault();
      if (!previewConnected || interactionBusy || isUploading()) return;
      const { selectionStart, selectionEnd, maxLength } = event.currentTarget;
      const next = message.slice(0, selectionStart) + "\n" + message.slice(selectionEnd);
      if (next.length > maxLength) return;
      if (next === message) {
        event.currentTarget.setSelectionRange(selectionStart + 1, selectionStart + 1);
        return;
      }
      pendingCaret.current = selectionStart + 1;
      setMessage(next);
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    void send().catch(() => undefined);
  };
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !previewExpanded ||
      !previewConnected ||
      event.altKey ||
      (event.ctrlKey && !isControlJ(event)) ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    const key = isControlJ(event) ? "enter" : PREVIEW_KEYS[event.key];
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
    <AttachmentMenu
      previewConnected={previewConnected}
      interactionBusy={interactionBusy}
      uploadProgress={uploadProgress}
      onFiles={(files) => void uploadFiles(files)}
      onError={setUploadError}
    >
      {(attachmentMenu) => (
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
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label="Dismiss interaction error"
                >
                  ×
                </button>
              </div>
            ) : null}
            {!previewConnected && uploadError ? <p role="alert">{uploadError}</p> : null}
            {operationStatus}
            {previewConnected ? renderConnectedInteraction(attachmentMenu) : null}
            <p className="interaction-summary">{sessionSummary(itemCount, updatedAt)}</p>
          </div>
        </section>
      )}
    </AttachmentMenu>
  );

  function renderConnectedInteraction(attachmentMenu: ReactNode) {
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
            event.dataTransfer.dropEffect = isUploading() || interactionBusy ? "none" : "copy";
            setDragging(!isUploading() && !interactionBusy);
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
              if (!isUploading()) setUploadError("Folders are not supported");
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
          <AttachmentList
            attachments={attachments}
            disabled={interactionBusy || !!uploadProgress}
            onRemove={removeAttachment}
          />
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
            placeholder={
              "Send a prompt… Paste images or drop files.\n\nClick Send or Shift+Enter to send."
            }
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
              {attachmentMenu}
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

function isControlJ(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "j";
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

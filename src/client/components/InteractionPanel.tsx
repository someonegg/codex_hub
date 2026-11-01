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
import { useTranslation } from "react-i18next";

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewSnapshot,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";

import type { PlainMessageKey } from "../i18n";
import { formatDate, formatNumber, t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";
import { usePreferences } from "../state/preferences";
import { useSessionDraft } from "../state/session-drafts";
import { useAttachmentUpload } from "../state/use-attachment-upload";
import { AttachmentList } from "./AttachmentList";
import { AttachmentMenu } from "./AttachmentMenu";
import { InternalLink } from "./InternalLink";
import { RequestError } from "./RequestError";

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
  errorDetail?: unknown;
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
  previewErrorDetail?: unknown;
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
  errorDetail,
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
  previewErrorDetail,
  onDismissPreviewError,
  previewExpanded,
  onTogglePreview,
}: InteractionPanelProps) {
  useTranslation();
  const { enterToSend } = usePreferences();
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
  useEffect(() => {
    const blurWhenHidden = () => {
      if (document.hidden && document.activeElement === composer.current) composer.current?.blur();
    };
    document.addEventListener("visibilitychange", blurWhenHidden);
    return () => document.removeEventListener("visibilitychange", blurWhenHidden);
  }, []);
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
  const focusPreviewOnExpand = useRef(false);
  const hadPreviewContent = useRef(false);
  const previewContentId = useId();
  const previewBody = useRef<HTMLDivElement | null>(null);
  const previewToggle = useRef<HTMLButtonElement | null>(null);
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
    if (previewExpanded && previewConnected && focusPreviewOnExpand.current)
      previewBody.current?.focus({ preventScroll: true });
    focusPreviewOnExpand.current = false;
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
    if (!previewConnected || interactionBusy || isUploading() || messageIsBlank || messageTooLarge)
      return;
    const command = message.trimEnd();
    const shouldExpandPreview =
      !attachments.length &&
      /^\/[A-Za-z]+$/.test(command) &&
      command !== "/exit" &&
      command !== "/quit";
    await onSendMessage(outgoingMessage);
    clearSentMessage();
    if (!mounted.current || !shouldExpandPreview || wasPreviewExpanded.current) return;
    scrollOnExpand.current = true;
    onExpandPreview();
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
    if (
      event.key !== "Enter" ||
      event.nativeEvent.isComposing ||
      // WebKit may report the IME-confirming Enter after composition has ended.
      event.nativeEvent.keyCode === 229 ||
      (enterToSend ? event.shiftKey : !event.shiftKey)
    )
      return;
    event.preventDefault();
    if (event.repeat) return;
    void send().catch(() => undefined);
  };
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !previewExpanded ||
      !previewConnected ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    if (event.ctrlKey) {
      if (event.key.toLowerCase() !== "c") return;
      event.preventDefault();
      sendKeys(["interrupt"]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onTogglePreview();
      previewToggle.current?.focus({ preventScroll: true });
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
        <span className="resume-reason">{t("ensureTheOriginalSessionHasExited")}</span>
      </div>
    ) : (
      statusLabel
    );
  const togglePreview = () => {
    if (!previewExpanded) {
      scrollOnExpand.current = true;
      focusPreviewOnExpand.current = true;
    }
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
        <section ref={setPanel} className="interaction-panel" aria-label={t("sessionInteraction")}>
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
                    {t("goToBoundSession")}
                  </InternalLink>
                ) : (
                  <span>{t("replacementSessionUnavailable")}</span>
                )
              ) : null}
              <div className="interaction-management-actions">{recoveryActions}</div>
            </div>
          ) : null}
          <div className="interaction-panel-content">
            {error ? (
              <div className="interaction-error" role="alert">
                <span>
                  <RequestError error={errorDetail ?? error} />
                </span>
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label={t("dismissInteractionError")}
                >
                  ×
                </button>
              </div>
            ) : null}
            {!previewConnected && uploadError ? (
              <p role="alert">
                <RequestError error={uploadError} />
              </p>
            ) : null}
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
        <section className="terminal-preview" aria-label={t("terminalPreview")}>
          <div className="terminal-preview-header">
            <button
              type="button"
              ref={previewToggle}
              className="terminal-preview-toggle"
              aria-expanded={previewExpanded}
              aria-label={t("terminalPreview")}
              aria-controls={previewContentId}
              onClick={togglePreview}
              disabled={!previewConnected}
            >
              <span className="terminal-preview-mark" aria-hidden="true">
                {preview !== null && previewExpanded ? "▾" : "▸"}
              </span>
              <span>{t("terminalPreview")}</span>
              {interaction?.supported &&
              (interaction.activity === "working" || interaction.activity === "idle") ? (
                <span
                  className={`terminal-activity terminal-activity-${interaction.activity}`}
                  role="status"
                >
                  <span className="terminal-activity-dot" aria-hidden="true" />
                  {interaction.activity === "working" ? t("working") : t("idle")}
                </span>
              ) : null}
              {preview === null && previewBusy ? (
                <span className="terminal-preview-status">{t("capturing")}</span>
              ) : null}
            </button>
          </div>
          {previewStopped ? (
            <div className="terminal-preview-notice" role="status">
              <span>{t("previewUpdatesStopped")}</span>{" "}
              <button type="button" onClick={onRetryPreview} disabled={previewBusy}>
                {previewBusy ? t("reconnecting") : t("retryPreview")}
              </button>
            </div>
          ) : null}
          {previewError ? (
            <div className="interaction-error terminal-preview-error" role="alert">
              <span>
                <RequestError error={previewErrorDetail ?? previewError} />
              </span>
              <button
                type="button"
                onClick={onDismissPreviewError}
                aria-label={t("dismissTerminalPreviewError")}
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
                  {t("terminalOutputExceededThePreviewLimitTheBeginningWasOmitted")}
                </p>
              ) : null}
              {preview && preview.content.length > 0 ? (
                <pre ref={previewContent} aria-label={t("terminalPreviewContent")} tabIndex={0}>
                  <span key={preview.capturedAt} className="terminal-preview-content">
                    {preview.content}
                  </span>
                </pre>
              ) : (
                <p className="terminal-preview-empty">
                  {preview === null && previewBusy
                    ? t("capturingTerminalPane")
                    : preview === null
                      ? t("terminalPreviewUnavailable")
                      : t("theTerminalPaneIsEmpty")}
                </p>
              )}
              <div className="terminal-keypad" role="group" aria-label={t("terminalControls")}>
                {TERMINAL_CONTROL_KEYS.map(({ key, label, glyph }) => (
                  <button
                    key={key}
                    type="button"
                    className={`terminal-key terminal-key-${key}`}
                    aria-label={t(label)}
                    disabled={!previewConnected}
                    aria-disabled={interactionBusy || !!uploadProgress || !previewConnected}
                    onClick={() => sendKeys([key])}
                  >
                    <span aria-hidden="true">{key === "plan" ? t("plan") : glyph}</span>
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
              if (!isUploading()) setUploadError(new LocalizedError("foldersAreNotSupported"));
              return;
            }
            void uploadFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {dragging ? <p role="status">{t("dropFilesToUpload")}</p> : null}
          {uploadProgress ? <p role="status">{uploadProgress}</p> : null}
          {uploadError ? (
            <div className="interaction-error" role="alert">
              <RequestError error={uploadError} />
              <button
                type="button"
                aria-label={t("dismissUploadError")}
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
            aria-label={t("messageToAgent")}
            value={message}
            rows={4}
            maxLength={MAX_INTERACTION_MESSAGE_BYTES}
            placeholder={t(enterToSend ? "shiftNewline" : "shiftSend")}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {messageTooLarge ? (
            <p className="interaction-message-limit" role="alert">
              {t("messageLimit", {
                size: formatNumber(messageBytes),
                limit: formatNumber(MAX_INTERACTION_MESSAGE_BYTES),
              })}
            </p>
          ) : null}
          <div className="interaction-actions">
            <div className="interaction-secondary-actions">
              <button
                type="button"
                className="interaction-handoff"
                title={t("handOffThisPaneSBindingToTheActiveCodexSession")}
                disabled={!previewConnected || interactionBusy || !!uploadProgress}
                onClick={() => void handoff().catch(() => undefined)}
              >
                {t("handoff")}
              </button>
              <button
                type="button"
                className="interaction-interrupt"
                disabled={!previewConnected}
                aria-disabled={interactionBusy || !!uploadProgress || !previewConnected}
                onClick={() => sendKeys(["interrupt"])}
              >
                {t("interrupt")}
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
                {t("send")}
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
  if (state === "superseded") return { kind: "warning", label: t("superseded") };
  if (error !== null || previewError !== null) return { kind: "error", label: t("error") };
  if (state === "disconnected") return { kind: "warning", label: t("disconnected") };
  if (state === "unbound") return { kind: "warning", label: t("unbound") };
  if (state === "unknown") return { kind: "warning", label: t("connectionUnknown") };
  if (state === "unavailable") return { kind: "warning", label: t("unavailable") };
  return { kind: "connected", label: t("connected") };
}

const PREVIEW_KEYS: Readonly<Record<string, InteractionKey | undefined>> = {
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  Enter: "enter",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const TERMINAL_CONTROL_KEYS: ReadonlyArray<{
  readonly key: Extract<InteractionKey, "up" | "down" | "left" | "right" | "enter" | "plan">;
  readonly label: PlainMessageKey;
  readonly glyph: string;
}> = [
  { key: "enter", label: "enter", glyph: "Enter" },
  { key: "up", label: "up", glyph: "↑" },
  { key: "plan", label: "plan", glyph: "Plan" },
  { key: "left", label: "left", glyph: "←" },
  { key: "down", label: "down", glyph: "↓" },
  { key: "right", label: "right", glyph: "→" },
];

function sessionSummary(itemCount: number, updatedAt: string | null): string {
  const events = t("events", { count: itemCount });
  const date = updatedAt === null ? null : new Date(updatedAt);
  if (date === null || Number.isNaN(date.valueOf())) return t("unknownUpdateSummary", { events });
  return t("updatedSummary", { events, time: formatDate(date, { timeStyle: "medium" }) });
}

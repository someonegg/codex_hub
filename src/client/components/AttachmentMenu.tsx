import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface AttachmentMenuProps {
  previewConnected: boolean;
  interactionBusy: boolean;
  uploadProgress: string | null;
  onFiles: (files: File[]) => void;
  onError: (error: string) => void;
  // Keep inputs mounted across connection changes to validate late picker results.
  children: (actions: ReactNode) => ReactNode;
}

export function AttachmentMenu({
  previewConnected,
  interactionBusy,
  uploadProgress,
  onFiles,
  onError,
  children,
}: AttachmentMenuProps) {
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const attachmentButton = useRef<HTMLButtonElement | null>(null);
  const attachmentMenu = useRef<HTMLDivElement | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const imagesInput = useRef<HTMLInputElement | null>(null);
  const filesInput = useRef<HTMLInputElement | null>(null);
  const attachmentPickers = [
    { label: "Take photo", input: photoInput, accept: "image/*", capture: "environment" },
    { label: "Choose images", input: imagesInput, accept: "image/*", multiple: true },
    { label: "Choose files", input: filesInput, multiple: true },
  ] as const;
  const attachmentMenuId = useId();
  const openAttachments = () => {
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
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    );
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
    attachmentMenu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [attachmentsOpen]);
  useEffect(() => {
    if (interactionBusy || !previewConnected) setAttachmentsOpen(false);
  }, [interactionBusy, previewConnected]);
  const chooseFiles = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    if (!previewConnected || interactionBusy) {
      onError(
        !previewConnected ? "Reconnect before attaching files" : "Session is busy; try again later",
      );
      return;
    }
    onFiles(files);
  };
  return (
    <>
      {attachmentPickers.map(({ label, input, ...options }) => (
        <input
          key={label}
          ref={input}
          type="file"
          {...options}
          hidden
          aria-label={label}
          onChange={(event) => chooseFiles(event.currentTarget)}
        />
      ))}
      {children(
        <>
          <button
            ref={attachmentButton}
            type="button"
            className="interaction-attach"
            aria-label="Attach files"
            aria-haspopup="menu"
            aria-expanded={attachmentsOpen}
            aria-controls={attachmentsOpen ? attachmentMenuId : undefined}
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
              aria-label="Attach files"
              className="interaction-attachment-menu"
              onKeyDown={onAttachmentMenuKeyDown}
            >
              {attachmentPickers.map(({ label, input }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  disabled={!previewConnected || interactionBusy || !!uploadProgress}
                  onClick={() => {
                    input.current?.click();
                    closeAttachments();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </>,
      )}
    </>
  );
}

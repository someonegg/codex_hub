import { useEffect, useRef } from "react";

import { AttachCommand } from "./AttachCommand";

export function TmuxAccessDialog({ command, onClose }: { command: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="terminal-connection-dialog"
      aria-label="tmux access"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="dialog-close"
        aria-label="Close tmux access"
        onClick={onClose}
      >
        ×
      </button>
      <AttachCommand command={command} />
    </dialog>
  );
}

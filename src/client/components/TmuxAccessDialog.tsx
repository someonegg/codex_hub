import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { t } from "../i18n";
import { AttachCommand } from "./AttachCommand";

export function TmuxAccessDialog({ command, onClose }: { command: string; onClose: () => void }) {
  useTranslation();
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
      aria-label={t("tmuxAccessLabel")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="dialog-close"
        aria-label={t("closeTmuxAccess")}
        onClick={onClose}
      >
        ×
      </button>
      <AttachCommand command={command} />
    </dialog>
  );
}

import { useState } from "react";

export function AttachCommand({ command }: { command: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="attach-command">
      <p>tmux access</p>
      <pre>{command}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setMessage("Copied"),
            () => setMessage("Copy failed. Select the command and copy it manually."),
          );
          if (!navigator.clipboard)
            setMessage("Copy failed. Select the command and copy it manually.");
        }}
      >
        Copy command
      </button>
      {message ? <small role="status">{message}</small> : null}
    </div>
  );
}

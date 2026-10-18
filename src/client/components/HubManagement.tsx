import { useEffect, useId, useRef, useState } from "react";

import type { HubOperation, SessionHome } from "../../shared/api-contract";
import type { SessionDetail } from "../../shared/domain";

import { api } from "../api/client";
import { useHubOperation } from "../state/use-hub-operation";
import { AttachCommand } from "./AttachCommand";

// getRandomValues is available over HTTP as well as in secure contexts.
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type OperationController = ReturnType<typeof useHubOperation>;
function OperationStatus({ controller }: { controller: OperationController }) {
  const op = controller.operation;
  const [dismissed, setDismissed] = useState<HubOperation | null>(null);
  useEffect(() => {
    if (op?.status !== "succeeded") return;
    const timer = setTimeout(() => setDismissed(op), 5_000);
    return () => clearTimeout(timer);
  }, [op]);
  return (
    <>
      {op && op !== dismissed ? (
        <aside className="operation-status" role="status">
          <strong>
            {op.type} · {op.status}
          </strong>
          {op.status === "pending" && op.type === "create" ? (
            <p>
              {op.attachCommand
                ? "No Codex session detected yet. Attach to tmux to check startup progress."
                : "Starting Codex"}
            </p>
          ) : null}
          {op.status === "pending" && op.phase ? (
            <p>
              {
                {
                  sending_exit: "Sending exit command",
                  waiting_exit: "Waiting for exit",
                  archiving: "Archiving",
                  confirming_archive: "Confirming archive",
                }[op.phase]
              }
            </p>
          ) : null}
          {op.attachCommand ? <AttachCommand command={op.attachCommand} /> : null}
          {op.status === "unknown" ? (
            <p>
              Tracking has stopped. Refresh the session list to check the result.{" "}
              {op.type === "create"
                ? "Attach to tmux before trying again; creating again may start another session."
                : "Check the current state before trying again."}
            </p>
          ) : null}
          {op.error ? <p>{op.error}</p> : null}
          <small>Operation {op.operationId}</small>
        </aside>
      ) : null}
      {controller.error ? (
        <div role="alert">
          <p>{controller.error}</p>
          {controller.canCheck ? (
            <button type="button" onClick={controller.check}>
              Retry status check
            </button>
          ) : controller.errorPhase === "submit" ? (
            <p>Use the original create, archive, or delete button to submit again.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
interface CreateSessionProps {
  homes?: readonly SessionHome[];
  selectedHome?: string;
  project: string;
  projects: readonly { project: string }[];
  onCreated: (op: HubOperation) => void;
  open?: boolean;
  onClose?: () => void;
  onRecovered?: () => void;
}

export function CreateSession({
  homes = [],
  selectedHome = "",
  project,
  projects,
  onCreated,
  open = true,
  onClose,
  onRecovered,
}: CreateSessionProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const recovery = useRef<boolean | null>(null);
  if (recovery.current === null) {
    try {
      recovery.current = sessionStorage.getItem("codex-hub.operation.create") !== null;
    } catch {
      recovery.current = false;
    }
  }
  const [directory, setDirectory] = useState(project);
  const initialHome =
    selectedHome ||
    homes.find((home) => home.nickname === "default")?.sourceInstanceId ||
    (homes.length === 1 ? homes[0]!.sourceInstanceId : "");
  const [sourceInstanceId, setSourceInstanceId] = useState(initialHome);
  useEffect(() => {
    if (open) setSourceInstanceId(initialHome);
  }, [open, initialHome]);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal?.();
      dialog.current?.querySelector<HTMLInputElement>("input[list]")?.focus();
    } else dialog.current?.close?.();
  }, [open]);
  const [worktree, setWorktree] = useState(false);
  const [yolo, setYolo] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const controller = useHubOperation("create", onCreated);
  useEffect(() => {
    if (!recovery.current || (controller.operation === null && controller.error === null)) return;
    recovery.current = false;
    if (controller.operation?.status !== "succeeded") onRecovered?.();
  }, [controller.operation, controller.error, onRecovered]);
  useEffect(() => {
    if (open) setDirectory(project);
  }, [project, open]);
  useEffect(() => {
    if (controller.operation && controller.operation.status !== "pending") request.current = null;
  }, [controller.operation]);
  return (
    <dialog ref={dialog} className="create-session" aria-label="New session" onCancel={onClose}>
      <button
        type="button"
        className="dialog-close"
        aria-label="Close new session"
        onClick={onClose}
      >
        ×
      </button>
      <h2>New session</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const fingerprint = JSON.stringify([sourceInstanceId, directory, worktree, yolo]);
          if (request.current?.fingerprint !== fingerprint)
            request.current = { fingerprint, id: newRequestId() };
          void controller.start(() =>
            api.createSession({
              ...(sourceInstanceId ? { sourceInstanceId } : {}),
              directory,
              worktree,
              yolo,
              requestId: request.current!.id,
            }),
          );
        }}
      >
        {homes.length > 1 ? (
          <label>
            Home
            <select
              required
              aria-label="Session home"
              value={sourceInstanceId}
              disabled={controller.busy}
              onChange={(event) => setSourceInstanceId(event.target.value)}
            >
              <option value="" disabled>
                Select a home
              </option>
              {homes.map((home) => (
                <option key={home.sourceInstanceId} value={home.sourceInstanceId}>
                  {home.nickname}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Project directory
          <input
            autoFocus
            required
            list="project-directories"
            placeholder="/absolute/project/directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            disabled={controller.busy}
          />
        </label>
        <datalist id="project-directories">
          {projects.map((item) => (
            <option key={item.project} value={item.project} />
          ))}
        </datalist>
        <label className="check-row">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
            disabled={controller.busy}
          />
          Create Codex worktree
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={yolo}
            onChange={(event) => setYolo(event.target.checked)}
            disabled={controller.busy}
          />
          Enable --yolo
        </label>
        <button
          type="submit"
          disabled={
            controller.busy ||
            !directory.startsWith("/") ||
            (homes.length > 1 && !homes.some((home) => home.sourceInstanceId === sourceInstanceId))
          }
        >
          {controller.busy ? "Creating…" : "Create session"}
        </button>
      </form>
      <OperationStatus controller={controller} />
    </dialog>
  );
}
interface ManageSessionProps {
  session: SessionDetail;
  onChanged: () => void;
  onDeleted?: () => void;
}

export function ManageSession({ session, onChanged, onDeleted }: ManageSessionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const closeMenu = () => {
    setMenuOpen(false);
    menu.current?.querySelector<HTMLButtonElement>(".session-menu-trigger")?.focus();
  };
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>(".session-action-menu button")?.focus();
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);
  const controller = useHubOperation(session.id, (operation) => {
    if (operation.type === "delete") {
      if (onDeleted) onDeleted();
      else window.location.assign("/");
    } else onChanged();
  });
  return (
    <div
      className="session-management"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMenuOpen(false);
          menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        className="session-menu-trigger"
        aria-label="Session management"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        ⋯
      </button>
      {menuOpen ? (
        <div className="session-action-menu" id={menuId}>
          {session.archived ? (
            <button
              type="button"
              disabled={controller.busy}
              onClick={() => {
                closeMenu();
                if (
                  window.confirm("Permanently delete this archived session? This cannot be undone.")
                )
                  void controller.start(() => api.deleteSession(session.id));
              }}
            >
              Delete session
            </button>
          ) : (
            <button
              type="button"
              disabled={controller.busy}
              onClick={() => {
                closeMenu();
                void controller.start(() => api.archiveSession(session.id));
              }}
            >
              Archive session
            </button>
          )}
        </div>
      ) : null}
      <div className="session-operation-details">
        <OperationStatus controller={controller} />
      </div>
    </div>
  );
}

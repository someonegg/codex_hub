import { useEffect, useId, useRef, useState } from "react";

import type { HubOperation, SessionHome } from "../../shared/api-contract";
import type { SessionDetail } from "../../shared/domain";

import { api } from "../api/client";
import { useHubOperation } from "../state/use-hub-operation";
import { AttachCommand } from "./AttachCommand";
import { ProjectDirectory } from "./ProjectDirectory";

// getRandomValues is available over HTTP as well as in secure contexts.
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type OperationController = ReturnType<typeof useHubOperation>;
export function OperationStatus({ controller }: { controller: OperationController }) {
  const op = controller.operation;
  const [dismissed, setDismissed] = useState<HubOperation | null>(null);
  useEffect(() => {
    if (op?.status !== "succeeded") return;
    const timer = setTimeout(() => setDismissed(op), 2_000);
    return () => clearTimeout(timer);
  }, [op]);
  return (
    <>
      {op && op !== dismissed ? (
        <aside className="operation-status" role="status">
          <strong>
            {op.mode === "resume" ? "resume" : op.type} · {op.status}
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
            <p>Use the original action button to try again.</p>
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
      dialog.current?.querySelector<HTMLElement>("h2")?.focus();
    } else dialog.current?.close?.();
  }, [open]);
  const [worktree, setWorktree] = useState(false);
  const [yolo, setYolo] = useState(false);
  useEffect(() => {
    if (open) {
      setWorktree(false);
      setYolo(false);
    }
  }, [open]);
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
      <h2 tabIndex={-1}>New session</h2>
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
        <ProjectDirectory
          value={directory}
          projects={projects}
          disabled={controller.busy}
          onChange={setDirectory}
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
            disabled={controller.busy}
          />
          Enable worktree
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={yolo}
            onChange={(event) => setYolo(event.target.checked)}
            disabled={controller.busy}
          />
          Enable YOLO mode
        </label>
        <OperationStatus controller={controller} />
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
    </dialog>
  );
}
interface ManageSessionProps {
  session: SessionDetail;
  onChanged: () => void;
  onDeleted?: () => void;
  controller?: OperationController;
  showStatus?: boolean;
  onStart?: () => void;
}

export function ManageSession(props: ManageSessionProps) {
  return props.controller ? (
    <ManageSessionControls
      session={props.session}
      controller={props.controller}
      onStart={props.onStart}
      showStatus={
        props.showStatus ??
        (props.controller.operation?.type === "archive" ||
          props.controller.operation?.type === "delete")
      }
    />
  ) : (
    <StandaloneManageSession {...props} />
  );
}

function StandaloneManageSession({ session, onChanged, onDeleted }: ManageSessionProps) {
  const controller = useHubOperation(session.id, (operation) => {
    if (operation.type === "delete") {
      if (onDeleted) onDeleted();
      else window.location.assign("/");
    } else onChanged();
  });
  return <ManageSessionControls session={session} controller={controller} showStatus />;
}

function ManageSessionControls({
  session,
  controller,
  showStatus,
  onStart,
}: {
  session: SessionDetail;
  controller: OperationController;
  showStatus: boolean;
  onStart?: () => void;
}) {
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
          {session.status === "archived" ? (
            <button
              type="button"
              disabled={controller.busy}
              onClick={() => {
                closeMenu();
                if (
                  window.confirm("Permanently delete this archived session? This cannot be undone.")
                ) {
                  onStart?.();
                  void controller.start(() => api.deleteSession(session.id));
                }
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
                onStart?.();
                void controller.start(() => api.archiveSession(session.id));
              }}
            >
              Archive session
            </button>
          )}
        </div>
      ) : null}
      {showStatus ? (
        <div className="session-operation-details">
          <OperationStatus controller={controller} />
        </div>
      ) : null}
    </div>
  );
}

export function ResumeSession({
  session,
  controller,
  onStart,
}: {
  session: SessionDetail;
  controller: OperationController;
  onStart?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [yolo, setYolo] = useState(false);
  const request = useRef<{ yolo: boolean; id: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal?.();
    else dialog.current?.close?.();
  }, [open]);
  useEffect(() => {
    if (controller.operation && controller.operation.status !== "pending") request.current = null;
    if (controller.operation?.status === "succeeded") setOpen(false);
  }, [controller.operation]);
  return (
    <>
      {session.resume.allowed ? (
        <button
          type="button"
          className="interaction-management-trigger"
          disabled={controller.busy}
          onClick={() => {
            setYolo(false);
            setOpen(true);
          }}
        >
          Resume
        </button>
      ) : (
        <span className="resume-reason">{session.resume.reason}</span>
      )}
      <dialog
        ref={dialog}
        className="create-session"
        aria-label="Resume session"
        onCancel={() => setOpen(false)}
      >
        <h2>Resume session</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!request.current || request.current.yolo !== yolo)
              request.current = { yolo, id: newRequestId() };
            onStart?.();
            void controller.start(() =>
              api.createSession({
                resumeSessionId: session.id,
                yolo,
                requestId: request.current!.id,
              }),
            );
            setOpen(false);
          }}
        >
          <label className="check-row">
            <input
              type="checkbox"
              checked={yolo}
              disabled={controller.busy}
              onChange={(event) => setYolo(event.target.checked)}
            />
            Enable YOLO mode
          </label>
          <button type="submit" disabled={controller.busy || !session.resume.allowed}>
            Resume session
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      </dialog>
    </>
  );
}

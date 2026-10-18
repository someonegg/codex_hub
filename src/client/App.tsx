import { useEffect, useMemo, useState } from "react";

import { CreateSession } from "./components/HubManagement";
import { HubSidebar } from "./components/HubSidebar";
import { InternalLink } from "./components/InternalLink";
import { SessionPage } from "./SessionPage";
import { useHubNavigation } from "./state/use-hub-navigation";
import { useSessionList } from "./state/use-session-list";
export function App() {
  const catalog = useSessionList();
  const [homeFilter, setHomeFilter] = useState(() => {
    try {
      return sessionStorage.getItem("codex-hub.home") ?? "";
    } catch {
      return "";
    }
  });
  const homes = catalog.list?.homes ?? [];
  const selectedHome = homes.some((home) => home.sourceInstanceId === homeFilter) ? homeFilter : "";
  useEffect(() => {
    if (!catalog.list) return;
    if (homeFilter !== selectedHome) setHomeFilter("");
    try {
      sessionStorage.setItem("codex-hub.home", selectedHome);
    } catch {
      /* Storage may be unavailable. */
    }
  }, [catalog.list, homeFilter, selectedHome]);
  const visibleList = useMemo(
    () =>
      !selectedHome || !catalog.list
        ? catalog.list
        : {
            ...catalog.list,
            sessions: catalog.list.sessions.filter(
              (session) => session.sourceInstanceId === selectedHome,
            ),
          },
    [catalog.list, selectedHome],
  );
  const visibleCatalog = { ...catalog, list: visibleList };
  const hub = useHubNavigation(catalog.list);
  const { sessionId, navigation, navigate, selectedProject } = hub;
  const [createDirectory, setCreateDirectory] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  return (
    <main className={`hub${sessionId ? " has-session" : ""}`}>
      {createdSessionId ? (
        <aside className="creation-notice" role="status">
          Session created.{" "}
          <InternalLink
            href={`/sessions/${createdSessionId}`}
            onNavigate={() => {
              navigate(createdSessionId);
              setCreatedSessionId(null);
            }}
          >
            Open session
          </InternalLink>
          <button
            type="button"
            aria-label="Dismiss session created notification"
            onClick={() => setCreatedSessionId(null)}
          >
            ×
          </button>
        </aside>
      ) : null}
      <HubSidebar
        catalog={visibleCatalog}
        homeFilter={selectedHome}
        onHomeFilter={setHomeFilter}
        hub={hub}
        onCreate={(directory) => {
          setCreateDirectory(directory);
          setCreateOpen(true);
        }}
      />
      <div className="hub-content">
        {sessionId ? (
          <>
            <div className="hub-topbar">
              <button className="hub-back" type="button" onClick={() => navigate(null)}>
                ← Back to list
              </button>
              <span>Projects</span>
              <span aria-hidden="true">/</span>
              <strong>
                {catalog.list?.projects
                  .find((project) => project.id === selectedProject)
                  ?.directory.split(/[\\/]/)
                  .filter(Boolean)
                  .at(-1) ?? "Unknown project"}
              </strong>
              <span aria-hidden="true">/</span>
              <span>Session</span>
            </div>
            <SessionPage
              key={sessionId}
              sessionId={sessionId}
              sessions={catalog.list?.sessions ?? []}
              homes={homes}
              includeArchived={navigation.includeArchived}
              onNavigate={navigate}
              onCatalogChanged={catalog.refresh}
              onUpdatedAt={catalog.reportUpdatedAt}
            />
          </>
        ) : (
          <section className="hub-welcome">
            <p className="eyebrow">Project hub</p>
            <h1>Select a session from the sidebar</h1>
            <p>Browse sessions by project, read their history, and continue your work.</p>
            <button
              type="button"
              onClick={() => {
                setCreateDirectory(null);
                setCreateOpen(true);
              }}
            >
              New session
            </button>
          </section>
        )}
      </div>
      <CreateSession
        homes={homes}
        selectedHome={selectedHome}
        project={createDirectory ?? ""}
        projects={(catalog.list?.projects ?? []).map((item) => ({ project: item.directory }))}
        open={createOpen}
        onRecovered={() => setCreateOpen(true)}
        onClose={() => setCreateOpen(false)}
        onCreated={(operation) => {
          setCreateOpen(false);
          catalog.refresh();
          if (!operation.sessionId) return;
          if (createOpen) {
            setCreatedSessionId(null);
            navigate(operation.sessionId);
          } else {
            setCreatedSessionId(operation.sessionId);
          }
        }}
      />
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArtifactsPage } from "./components/ArtifactsPage";
import { DiffPage } from "./components/DiffPage";
import { CreateSession } from "./components/HubManagement";
import { HubSidebar } from "./components/HubSidebar";
import { InternalLink } from "./components/InternalLink";
import { SidebarToggle } from "./components/SidebarToggle";
import { UploadsPage } from "./components/UploadsPage";
import { t } from "./i18n";
import { SessionPage } from "./SessionPage";
import { browserStorage } from "./state/browser-storage";
import { SessionDraftProvider } from "./state/session-drafts";
import { useHubNavigation } from "./state/use-hub-navigation";
import { useSessionList } from "./state/use-session-list";
export function App() {
  if (location.pathname.startsWith("/diffs/")) return <DiffPage />;
  if (location.pathname === "/artifacts") return <ArtifactsPage />;
  return (
    <SessionDraftProvider>
      <SessionHub />
    </SessionDraftProvider>
  );
}

function SessionHub() {
  useTranslation();
  const catalog = useSessionList();
  const [homeFilter, setHomeFilter] = useState(() => browserStorage.getItem("ahub.home") ?? "");
  const homes = catalog.list?.homes ?? [];
  const selectedHome = homes.some((home) => home.nickname === homeFilter) ? homeFilter : "";
  useEffect(() => {
    if (!catalog.list) return;
    if (homeFilter !== selectedHome) setHomeFilter("");
    browserStorage.setItem("ahub.home", selectedHome);
  }, [catalog.list, homeFilter, selectedHome]);
  const visibleList = useMemo(
    () =>
      !selectedHome || !catalog.list
        ? catalog.list
        : {
            ...catalog.list,
            sessions: catalog.list.sessions.filter((session) => session.home === selectedHome),
          },
    [catalog.list, selectedHome],
  );
  const visibleCatalog = { ...catalog, list: visibleList };
  const hub = useHubNavigation(catalog.list);
  const { sessionId, navigation, navigate, selectedProject } = hub;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => browserStorage.getItem("ahub.sidebar-collapsed") === "true",
  );
  const [createDirectory, setCreateDirectory] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    browserStorage.setItem("ahub.sidebar-collapsed", String(collapsed));
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          collapsed ? ".hub-topbar .hub-sidebar-toggle" : ".hub-brand .hub-sidebar-toggle",
        )
        ?.focus({ preventScroll: true });
    });
  }
  return (
    <main
      className={`hub${sessionId ? " has-session" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
    >
      {createdSessionId ? (
        <aside className="creation-notice" role="status">
          {t("sessionCreated")}{" "}
          <InternalLink
            href={`/sessions/${createdSessionId}`}
            onNavigate={() => {
              navigate(createdSessionId);
              setCreatedSessionId(null);
            }}
          >
            {t("openSession")}
          </InternalLink>
          <button
            type="button"
            aria-label={t("dismissSessionCreatedNotification")}
            onClick={() => setCreatedSessionId(null)}
          >
            ×
          </button>
        </aside>
      ) : null}
      <HubSidebar
        onCollapse={toggleSidebar}
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
        <div className="hub-topbar">
          {sidebarCollapsed ? <SidebarToggle collapsed onToggle={toggleSidebar} /> : null}
          {sessionId ? (
            <>
              <button className="hub-back" type="button" onClick={() => navigate(null)}>
                {t("backToList")}
              </button>
              <span>{t("projects")}</span>
              <span aria-hidden="true">/</span>
              <strong>
                {catalog.list?.projects
                  .find((project) => project.directory === selectedProject)
                  ?.directory.split(/[\\/]/)
                  .filter(Boolean)
                  .at(-1) ?? t("unknownProject")}
              </strong>
              <span aria-hidden="true">/</span>
              <span>{t("session")}</span>
            </>
          ) : null}
        </div>
        {sessionId ? (
          <>
            {hub.uploadsOpen ? (
              <UploadsPage
                key={sessionId}
                sessionId={sessionId}
                onBack={() => navigate(sessionId)}
              />
            ) : (
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
            )}
          </>
        ) : (
          <section className="hub-welcome">
            <p className="eyebrow">{t("projectHub")}</p>
            <h1>{t("selectASessionFromTheSidebar")}</h1>
            <p>{t("browseSessionsByProjectReadTheirHistoryAndContinueYourWork")}</p>
            <button
              type="button"
              onClick={() => {
                setCreateDirectory(null);
                setCreateOpen(true);
              }}
            >
              {t("newSession")}
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

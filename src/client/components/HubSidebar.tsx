import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client";
import { formatDate, t } from "../i18n";
import { catalogGroups } from "../state/catalog-groups";
import type { useHubNavigation } from "../state/use-hub-navigation";
import type { useSessionList } from "../state/use-session-list";
import { ErrorState } from "./ErrorState";
import { InternalLink } from "./InternalLink";
import { Settings } from "./Settings";
import { StatusBadge } from "./StatusBadge";
interface HubSidebarProps {
  catalog: ReturnType<typeof useSessionList>;
  hub: ReturnType<typeof useHubNavigation>;
  homeFilter?: string;
  onHomeFilter?: (value: string) => void;
  onCreate: (directory: string | null) => void;
}
export function HubSidebar({
  catalog,
  hub,
  onCreate,
  homeFilter = "",
  onHomeFilter,
}: HubSidebarProps) {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  const [hosting, setHosting] = useState(false);
  useEffect(() => {
    void api
      .capabilities()
      .then((data) => setHosting(data.hosting === true))
      .catch(() => {});
  }, []);
  const {
    sessionId,
    navigation,
    setIncludeArchived,
    toggleProject,
    persistScroll,
    sidebar,
    projectNav,
    navigate,
  } = hub;
  const groups = useMemo(
    () => catalogGroups(catalog.list, navigation.includeArchived),
    [catalog.list, navigation.includeArchived],
  );
  const updatedAtLabels = useMemo(
    () =>
      new Map(
        (catalog.list?.sessions ?? []).map((item) => [
          item.id,
          shortActivity(item.updatedAt, language),
        ]),
      ),
    [catalog.list, language],
  );
  return (
    <aside ref={sidebar} className="hub-sidebar" aria-label={t("sessionList")}>
      <header className="hub-brand">
        <InternalLink href="/" onNavigate={() => navigate(null)}>
          <img className="brand-logo" src="/favicon.svg" alt="" width="29" height="29" />
          Codex Hub
        </InternalLink>
      </header>
      <div className="catalog-filters">
        {(catalog.list?.homes?.length ?? 0) > 1 ? (
          <label className="home-filter">
            {t("home")}
            <select
              aria-label={t("filterByHome")}
              value={homeFilter}
              onChange={(event) => onHomeFilter?.(event.target.value)}
            >
              <option value="">{t("allHomes")}</option>
              {catalog.list!.homes.map((home) => (
                <option key={home.sourceInstanceId} value={home.sourceInstanceId}>
                  {home.nickname}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="check-row archive-switch">
          <input
            type="checkbox"
            checked={navigation.includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          {t("archived")}
        </label>
      </div>
      <div className="hub-section-label">
        {t("projects")}
        <button
          type="button"
          aria-label={t("newSession")}
          onClick={() => {
            onCreate(null);
          }}
        >
          ＋
        </button>
      </div>
      <nav
        ref={projectNav}
        aria-label={t("projectsAndMainSessions")}
        onScroll={(event) => persistScroll(event.currentTarget)}
      >
        {catalog.listLoading ? <p role="status">{t("loadingSessions")}</p> : null}
        {catalog.list && groups.length === 0 ? (
          <p className="hub-empty">{t("noMainSessionsYet")}</p>
        ) : null}
        {groups.map((group) => {
          const groupName = group.id === null ? t("unknownProject") : group.name;
          const key = group.id ?? "unknown";
          const expanded = navigation.expanded.includes(key);
          return (
            <section className="hub-project" key={key} data-project={key}>
              <div className="project-heading">
                <button
                  type="button"
                  title={group.directory ?? groupName}
                  aria-label={t("projectSessions", {
                    project: groupName,
                    count: group.sessions.length,
                  })}
                  aria-expanded={expanded}
                  onClick={() => toggleProject(key)}
                >
                  <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                  <span className="project-name">{groupName}</span>
                  <small> {group.sessions.length}</small>
                </button>
                {group.directory ? (
                  <button
                    type="button"
                    aria-label={t("newProjectSession", { project: groupName })}
                    onClick={() => {
                      onCreate(group.directory);
                    }}
                  >
                    ＋
                  </button>
                ) : null}
              </div>
              {expanded ? (
                <ul>
                  {group.sessions.map((session) => {
                    const updatedAtLabel = updatedAtLabels.get(session.id);
                    return (
                      <li key={session.id}>
                        <InternalLink
                          href={`/sessions/${session.id}`}
                          aria-current={sessionId === session.id ? "page" : undefined}
                          title={session.title}
                          onNavigate={() => navigate(session.id)}
                        >
                          <span className="session-nav-copy">
                            <span>{session.title}</span>
                            {(catalog.list?.homes?.length ?? 0) > 1 ? (
                              <small className="session-nav-home">
                                {
                                  catalog.list!.homes.find(
                                    (home) => home.sourceInstanceId === session.sourceInstanceId,
                                  )?.nickname
                                }
                              </small>
                            ) : null}
                            {updatedAtLabel ? (
                              <time dateTime={session.updatedAt!}>{updatedAtLabel}</time>
                            ) : null}
                          </span>
                          <StatusBadge status={session.status} />
                        </InternalLink>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
        {catalog.listError ? (
          <ErrorState
            title={t("couldNotUpdateSessionList")}
            message={catalog.listError}
            onDismiss={catalog.clearListError}
            onRetry={catalog.retryList}
          />
        ) : null}
      </nav>
      <footer className="hub-sidebar-footer">
        <Settings homes={catalog.list?.homes ?? []} />
        {hosting ? (
          <a href="/artifacts" target="_blank" rel="noopener noreferrer">
            {t("publishedPages")}
          </a>
        ) : null}
      </footer>
    </aside>
  );
}

function shortActivity(value: string | null | undefined, language?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? null
    : formatDate(
        date,
        {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        },
        language,
      );
}

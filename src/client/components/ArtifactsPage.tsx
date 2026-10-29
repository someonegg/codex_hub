import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ArtifactsResponse, ArtifactSummary } from "../../shared/api-contract";

import { api } from "../api/client";
import type { PlainMessageKey } from "../i18n";
import { formatDate, t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";
import { RequestError } from "./RequestError";

export function ArtifactsPage() {
  const { i18n } = useTranslation();
  useEffect(() => {
    document.title = `${t("pages")} · Codex Hub`;
  }, [i18n.resolvedLanguage]);
  const [projects, setProjects] = useState<ArtifactsResponse["projects"]>([]);
  const [error, setError] = useState<unknown>("");
  const [notice, setNotice] = useState<PlainMessageKey | "">("");
  const [busy, setBusy] = useState(true);
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(location.origin + url);
      setNotice("linkCopied");
    } catch {
      setError(new LocalizedError("couldNotCopyLink"));
    }
  }
  const loadProjects = useCallback(async () => {
    const data = await api.artifacts();
    setProjects(data.projects);
  }, []);
  const runOperation = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }, []);
  function refresh() {
    return runOperation(loadProjects);
  }
  async function deleteArtifact(artifact: ArtifactSummary) {
    if (!confirm(t("deleteArtifact", { title: artifact.title }))) return;
    await runOperation(async () => {
      await api.deleteArtifact(artifact.id);
      await loadProjects();
    });
  }
  useEffect(() => {
    void runOperation(loadProjects);
  }, [loadProjects, runOperation]);
  return (
    <section className="artifacts-page">
      <a href="/">← Codex Hub</a>
      <header className="artifacts-heading">
        <div>
          <p className="eyebrow">{t("publishedSnapshots")}</p>
          <h1>{t("pages")}</h1>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          {t("refresh")}
        </button>
      </header>
      {!!error ? (
        <p role="alert">
          <RequestError error={error} />
        </p>
      ) : null}
      {notice ? <p role="status">{t(notice)}</p> : null}
      {busy ? <p role="status">{t("loadingPages")}</p> : null}
      {!busy && !error && projects.length === 0 ? <p>{t("noPublishedWebPages")}</p> : null}
      {projects.map((project) => (
        <section key={project.directory}>
          <h2>{project.directory}</h2>
          {project.artifacts.map((artifact) => (
            <article key={artifact.id}>
              <h3>{artifact.title}</h3>
              <time dateTime={artifact.updatedAt}>
                {formatDate(new Date(artifact.updatedAt), {
                  dateStyle: "short",
                  timeStyle: "medium",
                })}
              </time>
              <div className="artifact-actions">
                <a href={artifact.url} target="_blank" rel="noreferrer">
                  {t("open")}
                </a>
                <button type="button" onClick={() => void copyLink(artifact.url)}>
                  {t("copyLink")}
                </button>
                <button type="button" disabled={busy} onClick={() => void deleteArtifact(artifact)}>
                  {t("delete")}
                </button>
              </div>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}

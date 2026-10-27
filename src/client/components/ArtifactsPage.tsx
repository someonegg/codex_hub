import { useCallback, useEffect, useState } from "react";

import type { ArtifactsResponse, ArtifactSummary } from "../../shared/api-contract";

import { api } from "../api/client";

export function ArtifactsPage() {
  const [projects, setProjects] = useState<ArtifactsResponse["projects"]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(location.origin + url);
      setNotice("Link copied");
    } catch {
      setError("Could not copy link");
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
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, []);
  function refresh() {
    return runOperation(loadProjects);
  }
  async function deleteArtifact(artifact: ArtifactSummary) {
    if (!confirm(`Delete “${artifact.title}” and all its snapshots?`)) return;
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
          <p className="eyebrow">Published snapshots</p>
          <h1>Pages</h1>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {busy ? <p role="status">Loading pages…</p> : null}
      {!busy && !error && projects.length === 0 ? <p>No published web pages.</p> : null}
      {projects.map((project) => (
        <section key={project.directory}>
          <h2>{project.directory}</h2>
          {project.artifacts.map((artifact) => (
            <article key={artifact.id}>
              <h3>{artifact.title}</h3>
              <time dateTime={artifact.updatedAt}>
                {new Date(artifact.updatedAt).toLocaleString()}
              </time>
              <div className="artifact-actions">
                <a href={artifact.url} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button type="button" onClick={() => void copyLink(artifact.url)}>
                  Copy link
                </button>
                <button type="button" disabled={busy} onClick={() => void deleteArtifact(artifact)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";

interface Artifact {
  id: string;
  title: string;
  updatedAt: string;
  url: string;
}
interface Project {
  directory: string;
  artifacts: Artifact[];
}
export function ArtifactsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
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
    const response = await fetch("/api/v1/artifacts");
    if (!response.ok) throw new Error("Could not load pages");
    const data = (await response.json()) as { projects: Project[] };
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
  async function deleteArtifact(artifact: Artifact) {
    if (!confirm(`Delete “${artifact.title}” and all its snapshots?`)) return;
    await runOperation(async () => {
      const response = await fetch(`/api/v1/artifacts/${artifact.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete page");
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

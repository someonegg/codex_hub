import "../styles/diff.css";

import { useEffect, useState } from "react";

import { type DiffLine, parseDiff } from "../../shared/diff";

import { DiffFileTree } from "./DiffFileTree";

const lineSigns = { add: "+", remove: "−", context: " " };

function renderDiffLine(line: DiffLine, index: number) {
  if (line.kind === "meta") {
    if (/^(diff --git |index |--- |\+\+\+ )/.test(line.text)) return null;
    return (
      <tr key={index} className={line.text.startsWith("@@") ? "diff-hunk" : "diff-meta"}>
        <td colSpan={4}>
          <pre>{line.text}</pre>
        </td>
      </tr>
    );
  }
  return (
    <tr key={index} className={`diff-${line.kind}`}>
      <td className="diff-line-number">{line.old}</td>
      <td className="diff-line-number">{line.next}</td>
      <td className="diff-sign" aria-hidden="true">
        {lineSigns[line.kind]}
      </td>
      <td className="diff-line-code">
        <pre>{line.text}</pre>
      </td>
    </tr>
  );
}

export function DiffPage() {
  const [entry, setEntry] = useState<{ title: string; raw: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1${location.pathname}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Diff not found or already cleaned up."
              : "Unable to load diff.",
          );
        return response.json();
      })
      .then(setEntry)
      .catch((error: Error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.title = entry?.title ?? "Diff";
  }, [entry?.title]);
  const parsed = entry ? parseDiff(entry.raw) : null;
  return (
    <main className="diff-page">
      {error ? (
        <p role="alert">{error}</p>
      ) : !entry || !parsed ? (
        <p>Loading diff…</p>
      ) : (
        <>
          <header className="diff-heading">
            <h1>{entry.title}</h1>
            <p className="diff-stats">
              <span>{parsed.files.length} files changed</span>
              <span className="diff-added">
                +{parsed.files.reduce((sum, file) => sum + file.additions, 0)}
              </span>
              <span className="diff-removed">
                −{parsed.files.reduce((sum, file) => sum + file.deletions, 0)}
              </span>
            </p>
          </header>
          {parsed.warning ? (
            <>
              <p role="status">
                Some content could not be fully parsed. Check the original text below.
              </p>
              <details className="diff-raw">
                <summary>View original diff</summary>
                <pre>{entry.raw}</pre>
              </details>
            </>
          ) : null}
          <div className="diff-layout">
            <DiffFileTree files={parsed.files} />
            <section aria-label="File diffs">
              {parsed.files.map((file, i) => (
                <details open id={`file-${i}`} key={i} className="diff-file">
                  <summary>
                    <span className="diff-file-path">{file.path}</span>
                    <span className="diff-file-stats">
                      <span className="diff-added">+{file.additions}</span>
                      <span className="diff-removed">−{file.deletions}</span>
                    </span>
                  </summary>
                  <div className="diff-code" tabIndex={0} aria-label={`Diff for ${file.path}`}>
                    <table>
                      <tbody>{file.lines.map(renderDiffLine)}</tbody>
                    </table>
                  </div>
                </details>
              ))}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

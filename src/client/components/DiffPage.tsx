import "../styles/diff.css";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DiffResponse } from "../../shared/api-contract";
import { type DiffLine, parseDiff } from "../../shared/diff";

import { api, ApiClientError } from "../api/client";
import type { PlainMessageKey } from "../i18n";
import { t } from "../i18n";
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
  const { i18n } = useTranslation();
  const [entry, setEntry] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<PlainMessageKey | "">("");
  useEffect(() => {
    const controller = new AbortController();
    api
      .diff(decodeURIComponent(location.pathname.slice("/diffs/".length)), controller.signal)
      .then(setEntry)
      .catch((error: Error) => {
        if (error.name !== "AbortError") {
          setError(
            error instanceof ApiClientError && error.status === 404
              ? "diffNotFoundOrAlreadyCleanedUp"
              : "unableToLoadDiff",
          );
        }
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.title = entry?.title ?? t("diff");
  }, [entry?.title, i18n.resolvedLanguage]);
  const parsed = entry ? parseDiff(entry.raw) : null;
  return (
    <main className="diff-page">
      {error ? (
        <p role="alert">{t(error)}</p>
      ) : !entry || !parsed ? (
        <p>{t("loadingDiff")}</p>
      ) : (
        <>
          <header className="diff-heading">
            <h1>{entry.title}</h1>
            <p className="diff-stats">
              <span>{t("filesChanged", { count: parsed.files.length })}</span>
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
              <p role="status">{t("someContentCouldNotBeFullyParsedCheckTheOriginalTextBelow")}</p>
              <details className="diff-raw">
                <summary>{t("viewOriginalDiff")}</summary>
                <pre>{entry.raw}</pre>
              </details>
            </>
          ) : null}
          <div className="diff-layout">
            <DiffFileTree files={parsed.files} />
            <section aria-label={t("fileDiffs")}>
              {parsed.files.map((file, i) => (
                <details open id={`file-${i}`} key={i} className="diff-file">
                  <summary>
                    <span className="diff-file-path">{file.path}</span>
                    <span className="diff-file-stats">
                      <span className="diff-added">+{file.additions}</span>
                      <span className="diff-removed">−{file.deletions}</span>
                    </span>
                  </summary>
                  <div
                    className="diff-code"
                    tabIndex={0}
                    aria-label={t("diffFor", { path: file.path })}
                  >
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

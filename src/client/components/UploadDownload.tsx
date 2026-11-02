import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { UploadAttachment } from "../../shared/uploads";

import { t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";
import { RequestError } from "./RequestError";

function isIOSStandalone() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    ios &&
    ((navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true)
  );
}

export function UploadDownload({ item, href }: { item: UploadAttachment; href: string }) {
  useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function save() {
    setError(null);
    setBusy(true);
    controller.current = new AbortController();
    const { signal } = controller.current;
    try {
      if (file) {
        // Keep share directly in the click handler: fetching first can expire user activation.
        await navigator.share({ files: [file] });
        if (!signal.aborted) setFile(null);
        return;
      }
      if (!navigator.share || !navigator.canShare) throw new LocalizedError("fileSaveUnsupported");
      const response = await fetch(href, { signal });
      if (!response.ok) throw new LocalizedError("fileDownloadFailed");
      const blob = await response.blob();
      if (signal.aborted) return;
      const prepared = new File([blob], item.filename, { type: item.type });
      if (!navigator.canShare({ files: [prepared] }))
        throw new LocalizedError("fileSaveUnsupported");
      setFile(prepared);
    } catch (reason) {
      if (!signal.aborted && !(reason instanceof DOMException && reason.name === "AbortError"))
        setError(reason);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  if (!isIOSStandalone())
    return (
      <a href={href} download={item.filename}>
        {t("download")}
      </a>
    );

  const actionLabel = t(file ? "saveFile" : "download");
  return (
    <div>
      <button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? t("preparingFile") : actionLabel}
      </button>
      {file && !busy ? (
        <>
          <p role="status">{t("saveFileHint")}</p>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setError(null);
            }}
          >
            {t("cancel")}
          </button>
        </>
      ) : null}
      {!!error ? (
        <p role="alert">
          <RequestError error={error} />
        </p>
      ) : null}
    </div>
  );
}

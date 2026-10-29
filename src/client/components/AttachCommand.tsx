import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { PlainMessageKey } from "../i18n";
import { t } from "../i18n";

export function AttachCommand({ command }: { command: string }) {
  useTranslation();
  const [message, setMessage] = useState<PlainMessageKey | "">("");
  return (
    <div className="attach-command">
      <p>{t("tmuxAccessLabel")}</p>
      <pre>{command}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setMessage("copied"),
            () => setMessage("copyFailedSelectTheCommandAndCopyItManually"),
          );
          if (!navigator.clipboard) setMessage("copyFailedSelectTheCommandAndCopyItManually");
        }}
      >
        {t("copyCommand")}
      </button>
      {message ? <small role="status">{t(message)}</small> : null}
    </div>
  );
}

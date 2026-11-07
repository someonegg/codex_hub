import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { t } from "../i18n";

export function ProjectDirectory({
  value,
  projects,
  disabled,
  onChange,
}: {
  value: string;
  projects: readonly { project: string }[];
  disabled: boolean;
  onChange: (directory: string) => void;
}) {
  useTranslation();
  const id = useId();
  const [custom, setCustom] = useState(false);
  const known = projects.some((item) => item.project === value);
  const editing = custom || projects.length === 0 || (!!value && !known);
  return (
    <div className="project-directory">
      <label htmlFor={projects.length ? id : `${id}-custom`}>{t("projectDirectoryLabel")}</label>
      {projects.length ? (
        <select
          id={id}
          required
          value={editing ? "custom" : value}
          disabled={disabled}
          onChange={(event) => {
            const other = event.target.value === "custom";
            setCustom(other);
            onChange(other ? "" : event.target.value);
          }}
        >
          <option value="" disabled>
            {t("selectProjectDirectory")}
          </option>
          {projects.map((item) => (
            <option key={item.project} value={item.project}>
              {item.project}
            </option>
          ))}
          <option value="custom">{t("otherProjectDirectory")}</option>
        </select>
      ) : null}
      {editing ? (
        <>
          {projects.length ? (
            <label htmlFor={`${id}-custom`}>{t("customProjectDirectory")}</label>
          ) : null}
          <input
            id={`${id}-custom`}
            required
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="/absolute/project/directory"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              setCustom(true);
              onChange(event.target.value);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

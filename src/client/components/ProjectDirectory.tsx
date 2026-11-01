import { useEffect, useId, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = value.toLowerCase();
  const options = projects.filter((item) => item.project.toLowerCase().includes(query));
  const activeOption = options[active];
  const expanded = open && !disabled && options.length > 0;
  useEffect(() => {
    if (expanded && active >= 0) {
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [active, expanded, id]);
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const select = (directory: string) => {
    onChange(directory);
    close();
  };
  return (
    <div
      className="project-directory"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          close();
        }
      }}
    >
      <label htmlFor={id}>{t("projectDirectoryLabel")}</label>
      <input
        id={id}
        required
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={expanded && activeOption ? `${id}-option-${active}` : undefined}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="/absolute/project/directory"
        value={value}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
            event.preventDefault();
            setOpen(true);
            let next = (active + 1) % options.length;
            if (event.key === "ArrowUp") {
              next = active <= 0 ? options.length - 1 : active - 1;
            }
            setActive(next);
          } else if (event.key === "Enter" && expanded && activeOption) {
            event.preventDefault();
            select(activeOption.project);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      />
      {expanded ? (
        <div id={`${id}-options`} role="listbox" aria-label={t("projectDirectories")}>
          {options.map((item, index) => (
            <button
              key={item.project}
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              aria-selected={active === index}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(item.project)}
            >
              {item.project}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

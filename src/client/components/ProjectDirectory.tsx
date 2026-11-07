import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
  const input = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = value.toLowerCase();
  const options = projects.filter((item) => item.project.toLowerCase().includes(query));
  const activeOption = options[active];
  const expanded = open && !disabled && options.length > 0;
  useLayoutEffect(() => {
    const field = input.current;
    const list = listbox.current;
    if (!expanded || !field || !list) return;
    const position = () => {
      const rect = field.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const below = Math.max(0, bottom - rect.bottom - 8);
      const above = Math.max(0, rect.top - top - 8);
      list.style.width = `${rect.width}px`;
      const preferredHeight = 10 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const upwards = below < Math.min(list.scrollHeight, preferredHeight) && above > below;
      list.style.left = `${rect.left}px`;
      list.style.maxHeight = `min(10rem, ${upwards ? above : below}px)`;
      list.style.top = `${upwards ? rect.top - list.offsetHeight - 4 : rect.bottom + 4}px`;
    };
    list.showPopover?.();
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(field);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      list.hidePopover?.();
    };
  }, [expanded, value, projects]);
  useEffect(() => {
    if (expanded && active >= 0) {
      const list = listbox.current;
      const option = document.getElementById(`${id}-option-${active}`);
      if (!list || !option) return;
      // Scroll only the suggestions, never the enclosing dialog or page.
      const top = option.offsetTop;
      const bottom = top + option.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight;
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
        ref={input}
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
        <div
          ref={listbox}
          id={`${id}-options`}
          popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined}
          role="listbox"
          aria-label={t("projectDirectories")}
        >
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

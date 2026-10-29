import { useTranslation } from "react-i18next";

import type { DiffFile } from "../../shared/diff";

import { t } from "../i18n";

interface Directory {
  directories: Map<string, Directory>;
  files: { name: string; index: number }[];
}

function buildTree(files: DiffFile[]): Directory {
  const root: Directory = { directories: new Map(), files: [] };
  files.forEach((file, index) => {
    const parts = file.path.split("/");
    const name = parts.pop()!;
    let directory = root;
    for (const part of parts) {
      let child = directory.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name, index });
  });
  return root;
}

function DirectoryEntries({ directory }: { directory: Directory }) {
  return (
    <ul>
      {[...directory.directories].map(([name, child]) => (
        <li key={`directory-${name}`}>
          <details open>
            <summary>{name}</summary>
            <DirectoryEntries directory={child} />
          </details>
        </li>
      ))}
      {directory.files.map(({ name, index }) => (
        <li key={`file-${index}`}>
          <a
            href={`#file-${index}`}
            onClick={() => {
              const target = document.getElementById(`file-${index}`);
              if (target instanceof HTMLDetailsElement) target.open = true;
            }}
          >
            {name}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function DiffFileTree({ files }: { files: DiffFile[] }) {
  useTranslation();
  return (
    <nav className="diff-tree" aria-label={t("changedFiles")}>
      <DirectoryEntries directory={buildTree(files)} />
    </nav>
  );
}

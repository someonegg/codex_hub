export interface DiffLine {
  text: string;
  kind: "add" | "remove" | "context" | "meta";
  old?: number;
  next?: number;
}
export interface DiffFile {
  path: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}
const pathEscapes: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  n: "\n",
  t: "\t",
  r: "\r",
};

/** Git quotes paths as C strings, including octal-escaped UTF-8 bytes. */
function decodePath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const inner = value.slice(1, value.lastIndexOf('"'));
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += octal[0].length;
        continue;
      }
      const escape = inner[++i];
      bytes.push(...new TextEncoder().encode(pathEscapes[escape] ?? escape));
    } else {
      const point = String.fromCodePoint(inner.codePointAt(i)!);
      bytes.push(...new TextEncoder().encode(point));
      i += point.length - 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function pathName(value: string): string {
  return decodePath(value).replace(/^[ab]\//, "");
}
/** Only repeated paths can be inferred reliably without extended headers. */
function headerPath(value: string): string | null {
  const quoted = /^"(?:[^"\\]|\\.)*" /.exec(value);
  let oldPath: string;
  let newPath: string;
  if (quoted) {
    oldPath = value.slice(0, quoted[0].length - 1);
    newPath = value.slice(quoted[0].length);
  } else {
    const quotedNew = / ("(?:[^"\\]|\\.)*")$/.exec(value);
    // Unquoted, identical paths have equal lengths, regardless of embedded spaces.
    const separator = quotedNew?.index ?? (value.length - 1) / 2;
    if (!Number.isInteger(separator) || value[separator] !== " ") return null;
    oldPath = value.slice(0, separator);
    newPath = value.slice(separator + 1);
  }
  const oldName = decodePath(oldPath);
  const newName = decodePath(newPath);
  return oldName.startsWith("a/") &&
    newName.startsWith("b/") &&
    oldName.slice(2) === newName.slice(2)
    ? newName.slice(2)
    : null;
}

export function parseDiff(raw: string): { files: DiffFile[]; warning: boolean } {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let pathResolved = false;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  let warning = false;
  const finishHunk = () => {
    if (oldRemaining || newRemaining) warning = true;
    inHunk = false;
    oldRemaining = newRemaining = 0;
  };
  const finishFile = () => {
    finishHunk();
    if (file && !pathResolved) warning = true;
  };
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --git ")) {
      finishFile();
      const path = headerPath(text.slice(11));
      pathResolved = path !== null;
      file = {
        path: path ?? text.slice(11),
        lines: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
    }
    if (!file) {
      if (text.trim()) warning = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      inHunk = true;
      file.lines.push({ text, kind: "meta" });
      continue;
    }
    if (inHunk && (oldRemaining || newRemaining) && /^[ +\-]/.test(text)) {
      const kind = text[0] === "+" ? "add" : text[0] === "-" ? "remove" : "context";
      const line: DiffLine = { text: text.slice(1), kind };
      if (kind !== "add") {
        line.old = oldLine++;
        oldRemaining--;
      }
      if (kind !== "remove") {
        line.next = newLine++;
        newRemaining--;
      }
      if (oldRemaining < 0 || newRemaining < 0) warning = true;
      if (kind === "add") file.additions++;
      if (kind === "remove") file.deletions++;
      file.lines.push(line);
      continue;
    }
    if (/^(\+\+\+|---) /.test(text)) {
      const path = text.slice(4);
      if (path !== "/dev/null") {
        file.path = pathName(path.replace(/\t$/, ""));
        pathResolved = true;
      }
    }
    const renamed = /^(?:rename|copy) to (.*)$/.exec(text);
    if (renamed) {
      file.path = decodePath(renamed[1]);
      pathResolved = true;
    }
    if (
      !/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files .* differ$|\\ No newline at end of file$)/.test(
        text,
      )
    )
      warning = true;
    if (inHunk && /^[+\- ]/.test(text)) warning = true;
    file.lines.push({ text, kind: "meta" });
  }
  finishFile();
  return { files, warning: warning || files.length === 0 };
}

import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const MAX_CONCURRENT_QUERIES = 4;

export type ProjectDirectoryQuery = (workingDirectory: string) => Promise<string | null>;

interface CacheEntry {
  readonly result: Promise<string>;
  expiresAt: number;
}

/** Resolves local Git relationships without interpreting rollout message contents. */
export class ProjectDirectoryResolver {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;

  constructor(
    private readonly query: ProjectDirectoryQuery = queryProjectDirectory,
    private readonly now: () => number = performance.now.bind(performance),
  ) {}

  async resolveAll(
    workingDirectories: readonly (string | null)[],
  ): Promise<ReadonlyMap<string | null, string | null>> {
    const unique = new Set(workingDirectories);
    for (const key of this.#cache.keys()) {
      if (!unique.has(key)) this.#cache.delete(key);
    }
    const pairs = await Promise.all(
      [...unique].map(async (directory) => [directory, await this.resolve(directory)] as const),
    );
    return new Map(pairs);
  }

  async resolve(workingDirectory: string | null): Promise<string | null> {
    if (workingDirectory === null) return null;
    const cached = this.#cache.get(workingDirectory);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.result;

    const entry: CacheEntry = {
      expiresAt: Number.POSITIVE_INFINITY,
      result: this.#query(workingDirectory),
    };
    this.#cache.set(workingDirectory, entry);
    void entry.result.then(() => {
      entry.expiresAt = this.now() + CACHE_TTL_MS;
    });
    return entry.result;
  }

  async #query(workingDirectory: string): Promise<string> {
    if (this.#active >= MAX_CONCURRENT_QUERIES) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active += 1;
    }
    try {
      return (await this.query(workingDirectory)) ?? workingDirectory;
    } catch {
      return workingDirectory;
    } finally {
      const next = this.#waiting.shift();
      if (next !== undefined) next();
      else this.#active -= 1;
    }
  }
}

async function queryProjectDirectory(workingDirectory: string): Promise<string | null> {
  if (!isAbsolute(workingDirectory)) return null;
  // A Git environment inherited from the hub must not override the session's repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workingDirectory, "worktree", "list", "--porcelain", "-z"],
    { env, timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
  );
  const primary = stdout.split("\0\0", 1)[0]!.split("\0");
  const header = primary[0];
  if (header === undefined || !header.startsWith("worktree ") || primary.includes("bare")) {
    return null;
  }
  const directory = header.slice("worktree ".length);
  return isAbsolute(directory) ? directory : null;
}

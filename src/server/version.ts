import { readFile } from "node:fs/promises";

export async function packageVersion(): Promise<string> {
  let directory = new URL("./", import.meta.url);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
      if (manifest.name === "@someonegg/codex-hub" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = new URL("../", directory);
    if (parent.href === directory.href) throw new Error("Cannot locate the Hub package version");
    directory = parent;
  }
}

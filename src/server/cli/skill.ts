import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CommandError } from "./command-error.js";

const bundledSkills = ["ahub-publish", "ahub-control"];
const usage = `Usage: ahub-cli skill path <${bundledSkills.join(" | ")}>`;

export async function runSkillCommand(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(usage);
    return;
  }
  const [command, skill] = args;
  if (args.length !== 2 || command !== "path" || !skill || !bundledSkills.includes(skill))
    throw new CommandError("invalid_arguments", usage);

  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    let name: unknown;
    try {
      name = JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name;
    } catch {
      // Continue through directories without a package manifest.
    }
    if (name === "@someonegg/codex-hub") {
      const path = join(directory, "skills", skill);
      if (!(await stat(join(path, "SKILL.md"))).isFile())
        throw new CommandError("command_failed", "Skill file is missing");
      console.log(path);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new CommandError("command_failed", "Cannot locate the Hub package");
    directory = parent;
  }
}

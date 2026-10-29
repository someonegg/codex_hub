import { CommandError } from "./command-error.js";

export function singleLine(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

export function output(result: unknown, json: boolean, human: string): void {
  console.log(json ? JSON.stringify(result) : human);
}

export function outputFailure(error: unknown, json: boolean): void {
  const failure =
    error instanceof CommandError
      ? error
      : new CommandError(
          error instanceof TypeError ||
            (error instanceof Error && error.message.startsWith("Unknown command:"))
            ? "invalid_arguments"
            : "command_failed",
          error instanceof Error ? error.message : "Command failed",
        );
  if (json)
    console.log(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
  else console.error(failure.message);
  process.exitCode = failure.exitCode;
}

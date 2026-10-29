import { ResourceValidationError } from "../hosting/validation-error.js";
import { CommandError } from "./command-error.js";

export function singleLine(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

export function output(result: unknown, json: boolean, human: string): void {
  console.log(json ? JSON.stringify(result) : human);
}

export function outputFailure(error: unknown, json: boolean): void {
  let failure: CommandError;
  if (error instanceof CommandError) {
    failure = error;
  } else {
    const code = error instanceof ResourceValidationError ? "invalid_arguments" : "command_failed";
    const message = error instanceof Error ? error.message : "Command failed";
    failure = new CommandError(code, message);
  }
  if (json)
    console.log(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
  else console.error(failure.message);
  process.exitCode = failure.exitCode;
}

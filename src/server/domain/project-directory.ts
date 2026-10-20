import { isAbsolute } from "node:path";

export function validProjectDirectory(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value);
}

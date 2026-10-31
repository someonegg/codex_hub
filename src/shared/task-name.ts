/** Task names must fit on one binding-output line without shell block delimiters. */
export function validTaskName(value: unknown): value is string {
  return typeof value === "string" && !/[<>\0\r\n]/.test(value);
}

export const TASK_NAME_ERROR = "Task name must be a string without <, >, NUL, or line breaks";

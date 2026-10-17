/** One independently cancellable read channel. Identity also guards APIs that ignore abort. */
export function createRequestChannel() {
  let current: AbortController | null = null;
  return {
    cancel() {
      current?.abort();
      current = null;
    },
    begin() {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      return {
        controller,
        signal: controller.signal,
        isCurrent: () => current === controller && !controller.signal.aborted,
      };
    },
  };
}

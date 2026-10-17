import { ApiClientError } from "../api/client";

export const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RETRY_JITTER = 0.2;

export function isRetryableRequestError(reason: unknown): boolean {
  return !(reason instanceof ApiClientError) || reason.status === 429 || reason.status >= 500;
}

export function nextRetryMs(current: number): number {
  return Math.min(current * 2, MAX_RETRY_MS);
}

export function retryDelayMs(milliseconds: number): number {
  return Math.round(milliseconds * (1 - RETRY_JITTER + Math.random() * RETRY_JITTER * 2));
}

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return waitForDelay(retryDelayMs(milliseconds), signal);
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = window.setTimeout(done, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

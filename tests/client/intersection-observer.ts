import { act } from "@testing-library/react";
import { vi } from "vitest";

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  element: Element | null;
  disconnected: boolean;
  options?: IntersectionObserverInit;
}

const observers: ObserverRecord[] = [];

export function installIntersectionObserver(): void {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds: readonly number[];
      readonly record: ObserverRecord;

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.rootMargin = options?.rootMargin ?? "0px";
        this.thresholds = [typeof options?.threshold === "number" ? options.threshold : 0];
        this.record = { callback, element: null, disconnected: false, options };
        observers.push(this.record);
      }

      observe(element: Element) {
        this.record.element = element;
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
}

export function intersectLatest(): void {
  const record = latestActiveObserver();
  if (record?.element === null || record === undefined) {
    throw new Error("No active infinite-scroll observer");
  }
  act(() =>
    record.callback(
      [
        {
          isIntersecting: true,
          target: record.element!,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
}

export function latestObserverOptions(): IntersectionObserverInit | undefined {
  return latestActiveObserver()?.options;
}

function latestActiveObserver(): ObserverRecord | undefined {
  for (let index = observers.length - 1; index >= 0; index -= 1) {
    const observer = observers[index];
    if (observer !== undefined && !observer.disconnected) return observer;
  }
  return undefined;
}

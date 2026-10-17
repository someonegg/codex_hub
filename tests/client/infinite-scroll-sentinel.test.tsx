import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InfiniteScrollSentinel } from "../../src/client/components/InfiniteScrollSentinel";
import {
  installIntersectionObserver,
  intersectLatest,
  latestObserverOptions,
} from "./intersection-observer";

// @vitest-environment jsdom

describe("infinite scroll sentinel", () => {
  it("claims each cursor once and observes 300px ahead of the viewport", () => {
    installIntersectionObserver();
    const onLoadMore = vi.fn();
    const view = render(
      <InfiniteScrollSentinel
        enabled
        triggerKey="cursor-one"
        loading={false}
        loadingLabel="Loading more…"
        onLoadMore={onLoadMore}
      />,
    );

    expect(latestObserverOptions()).toMatchObject({
      root: null,
      rootMargin: "0px 0px 300px 0px",
      threshold: 0,
    });
    intersectLatest();
    intersectLatest();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(
      <InfiniteScrollSentinel
        enabled
        triggerKey="cursor-two"
        loading={false}
        loadingLabel="Loading more…"
        onLoadMore={onLoadMore}
      />,
    );
    intersectLatest();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate a cursor during StrictMode effect replay", () => {
    installIntersectionObserver();
    const onLoadMore = vi.fn();
    render(
      <StrictMode>
        <InfiniteScrollSentinel
          enabled
          triggerKey="strict-cursor"
          loading={false}
          loadingLabel="Loading more…"
          onLoadMore={onLoadMore}
        />
      </StrictMode>,
    );

    intersectLatest();
    intersectLatest();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does not observe while disabled", () => {
    installIntersectionObserver();
    render(
      <InfiniteScrollSentinel
        enabled={false}
        triggerKey="disabled-cursor"
        loading={false}
        loadingLabel="Loading more…"
        onLoadMore={vi.fn()}
      />,
    );
    expect(() => intersectLatest()).toThrow("No active infinite-scroll observer");
  });
});

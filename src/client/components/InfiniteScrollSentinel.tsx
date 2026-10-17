import { useEffect, useRef } from "react";

interface InfiniteScrollSentinelProps {
  enabled: boolean;
  triggerKey: string;
  loading: boolean;
  loadingLabel: string;
  onLoadMore: () => void;
}

export function InfiniteScrollSentinel({
  enabled,
  triggerKey,
  loading,
  loadingLabel,
  onLoadMore,
}: InfiniteScrollSentinelProps) {
  const element = useRef<HTMLDivElement>(null);
  const callback = useRef(onLoadMore);
  const lastTriggeredKey = useRef<string | null>(null);
  callback.current = onLoadMore;

  useEffect(() => {
    if (!enabled || element.current === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !entries.some((entry) => entry.isIntersecting) ||
          lastTriggeredKey.current === triggerKey
        )
          return;
        lastTriggeredKey.current = triggerKey;
        callback.current();
      },
      {
        root: null,
        rootMargin: "0px 0px 300px 0px",
        threshold: 0,
      },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [enabled, triggerKey]);

  return (
    <div className="infinite-scroll-sentinel" ref={element}>
      {loading ? (
        <p className="loading" role="status">
          {loadingLabel}
        </p>
      ) : null}
    </div>
  );
}

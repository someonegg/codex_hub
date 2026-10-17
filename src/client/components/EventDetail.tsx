import type { ReactNode } from "react";

interface EventDetailProps {
  loading: boolean;
  loadingMessage: string;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}

export function EventDetail({
  loading,
  loadingMessage,
  error,
  onRetry,
  children,
}: EventDetailProps) {
  return (
    <div className="event-detail">
      {loading ? <p role="status">{loadingMessage}</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Retry loading detail
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onDismiss,
  onRetry,
}: {
  title: string;
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
      {onDismiss ? (
        <button className="error-dismiss" type="button" aria-label="Dismiss" onClick={onDismiss}>
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

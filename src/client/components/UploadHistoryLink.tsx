import { InternalLink } from "./InternalLink";

interface UploadHistoryLinkProps {
  sessionId: string;
  className?: string;
  role?: "menuitem";
  onNavigate?: () => void;
}

export function UploadHistoryLink({ sessionId, onNavigate, ...props }: UploadHistoryLinkProps) {
  const href = `/sessions/${encodeURIComponent(sessionId)}/uploads`;
  return (
    <InternalLink
      {...props}
      href={href}
      onNavigate={() => {
        window.history.pushState(null, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
        onNavigate?.();
      }}
    >
      Upload history
    </InternalLink>
  );
}

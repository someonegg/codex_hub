import type { ComponentProps } from "react";

interface InternalLinkProps extends ComponentProps<"a"> {
  onNavigate?: () => void;
}

export function InternalLink({ onNavigate, onClick, ...props }: InternalLinkProps) {
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          !onNavigate ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (event.currentTarget.target && event.currentTarget.target !== "_self") ||
          event.currentTarget.hasAttribute("download")
        )
          return;
        event.preventDefault();
        onNavigate();
      }}
    />
  );
}

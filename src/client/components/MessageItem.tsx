import type { ComponentProps, ReactNode } from "react";
import { memo, useId, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import type { MessageItem as Message } from "../../shared/domain";

import { EventTime } from "./EventTime";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];
const PREVIEW_PARSE_OPTIONS = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: ComponentProps<"a">) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="image-placeholder">[Image omitted{alt ? `: ${alt}` : ""}]</span>
  ),
  table: ({ node: _node, children, ...props }: ComponentProps<"table"> & ExtraProps) => (
    <MarkdownScrollRegion label="Scrollable table" kind="table">
      <table {...props}>{children}</table>
    </MarkdownScrollRegion>
  ),
  pre: ({ node: _node, children, ...props }: ComponentProps<"pre"> & ExtraProps) => (
    <MarkdownScrollRegion label="Scrollable code block" kind="code">
      <pre {...props}>{children}</pre>
    </MarkdownScrollRegion>
  ),
  span: ({ node: _node, className, children, ...props }: ComponentProps<"span"> & ExtraProps) => {
    if (className?.split(" ").includes("katex-display")) {
      return (
        <MarkdownScrollRegion label="Scrollable math formula" kind="math">
          <span className={className} {...props}>
            {children}
          </span>
        </MarkdownScrollRegion>
      );
    }
    return (
      <span className={className} {...props}>
        {children}
      </span>
    );
  },
};

function MarkdownScrollRegion({
  children,
  kind,
  label,
}: {
  children: ReactNode;
  kind: "code" | "math" | "table";
  label: string;
}) {
  return (
    <div
      className={`markdown-scroll-region markdown-scroll-${kind}`}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

export function safeUrlTransform(url: string): string {
  if (/^\/web\/[a-f0-9]{32}\/$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? defaultUrlTransform(url) : "";
  } catch {
    return "";
  }
}

export const MessageItem = memo(function MessageItem({ item }: { item: Message }) {
  const itemType = item.itemType === null ? "" : ` · ${item.itemType}`;
  if (isPlan(item)) return <PlanMessage item={item} />;
  return (
    <article
      className={`message-body ${item.role === "user" ? "user-message" : "assistant-message"}`}
    >
      <p className="event-label">
        {messageLabel(item)}
        {itemType} · {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <div className="message-content">
        <MarkdownContent markdown={item.markdown} />
      </div>
    </article>
  );
});

function PlanMessage({ item }: { item: Message }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const contentId = useId();
  const preview = useMemo(() => planPreview(item.markdown), [item.markdown]);
  return (
    <article className="message-body assistant-message plan-message">
      <button
        type="button"
        className="plan-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          setMounted(true);
          setOpen((value) => !value);
        }}
      >
        <span className="event-label">
          Assistant final · Plan · {item.ordinal}
          <EventTime timestamp={item.timestamp} />
        </span>
        <span className="plan-toggle-action">
          {open ? "Hide" : "Show"}
          <span className="plan-toggle-mark" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      {open ? null : (
        <p className="plan-preview message-content">{preview || "Plan content unavailable."}</p>
      )}
      {mounted ? (
        <div className="plan-content message-content" id={contentId} hidden={!open}>
          <MarkdownContent markdown={item.markdown} />
        </div>
      ) : null}
    </article>
  );
}

const MarkdownContent = memo(function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      skipHtml
      urlTransform={safeUrlTransform}
      components={MARKDOWN_COMPONENTS}
    >
      {markdown}
    </ReactMarkdown>
  );
});

function messageLabel(item: Message): string {
  if (item.role === "user") return "User";
  if (item.phase === "commentary") return "Assistant commentary";
  if (item.phase === "final") return "Assistant final";
  return "Assistant";
}

function isPlan(item: Message): boolean {
  return item.role === "assistant" && item.phase === "final" && item.itemType === "Plan";
}

function parsePlanPreview(markdown: string): string {
  try {
    const root = fromMarkdown(markdown, PREVIEW_PARSE_OPTIONS);
    return root.children
      .flatMap((node) =>
        node.type === "list"
          ? node.children.map((item) => toString(item))
          : node.type === "table"
            ? node.children.map((row) => row.children.map((cell) => toString(cell)).join(" · "))
            : [toString(node)],
      )
      .map((block) =>
        block
          .replaceAll(/<\/?proposed_plan>/gi, "")
          .replaceAll(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join("\n");
  } catch {
    return markdown
      .replaceAll(/<\/?proposed_plan>/gi, "")
      .replaceAll(/\s+/g, " ")
      .trim();
  }
}

export function planPreview(markdown: string): string {
  const source: string[] = [];
  for (const point of markdown) {
    source.push(point);
    if (source.length > 2000) break;
  }
  const text = Array.from(parsePlanPreview(source.slice(0, 2000).join("")));
  const truncated = source.length > 2000 || text.length > 320;
  return text.slice(0, truncated ? 319 : 320).join("") + (truncated ? "…" : "");
}

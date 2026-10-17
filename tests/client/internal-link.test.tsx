// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InternalLink } from "../../src/client/components/InternalLink";

describe("internal link browser behavior", () => {
  it("intercepts an ordinary primary click", () => {
    const navigate = vi.fn();
    render(
      <InternalLink href="/sessions/example" onNavigate={navigate}>
        Session
      </InternalLink>,
    );
    expect(fireEvent.click(screen.getByRole("link"))).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it.each([
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { button: 2 },
  ])("preserves browser behavior for %o", (options) => {
    const navigate = vi.fn();
    render(
      <InternalLink href="#session" onNavigate={navigate}>
        Session
      </InternalLink>,
    );
    expect(fireEvent.click(screen.getByRole("link"), options)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("respects a prevented event", () => {
    const navigate = vi.fn();
    render(
      <InternalLink
        href="#session"
        onNavigate={navigate}
        onClick={(event) => event.preventDefault()}
      >
        Session
      </InternalLink>,
    );
    expect(fireEvent.click(screen.getByRole("link"))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("remains a normal link without navigation", () => {
    render(<InternalLink href="#session">Session</InternalLink>);
    expect(fireEvent.click(screen.getByRole("link"))).toBe(true);
  });

  it.each([{ target: "_blank" }, { download: "session" }])(
    "respects anchor attributes %o",
    (props) => {
      const navigate = vi.fn();
      render(
        <InternalLink href="#session" onNavigate={navigate} {...props}>
          Session
        </InternalLink>,
      );
      expect(fireEvent.click(screen.getByRole("link"))).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});

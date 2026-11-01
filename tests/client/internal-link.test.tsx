// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InternalLink } from "../../src/client/components/InternalLink";

describe("internal link browser behavior", () => {
  it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }])(
    "preserves browser behavior for %o",
    (options) => {
      const navigate = vi.fn();
      render(
        <InternalLink href="#session" onNavigate={navigate}>
          Session
        </InternalLink>,
      );
      expect(fireEvent.click(screen.getByRole("link"), options)).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

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

  it("preserves a new-tab target", () => {
    const navigate = vi.fn();
    render(
      <InternalLink href="#session" onNavigate={navigate} target="_blank">
        Session
      </InternalLink>,
    );
    expect(fireEvent.click(screen.getByRole("link"))).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});

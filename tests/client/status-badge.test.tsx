// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { StatusBadge } from "../../src/client/components/StatusBadge";

it("uses a green Live marker, preserves Archived styling and omits Normal", () => {
  const view = render(<StatusBadge status="live" />);
  expect(screen.getByText("Live")).toHaveClass("live-label");
  view.rerender(<StatusBadge status="archived" />);
  expect(screen.getByText("Archived")).toHaveClass("archive-label");
  view.rerender(<StatusBadge status="normal" />);
  expect(view.container).toBeEmptyDOMElement();
});

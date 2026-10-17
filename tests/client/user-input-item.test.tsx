import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TimelineCursor } from "../../src/shared/api-contract";
import type { UserInputItem, UserInputRequestItem } from "../../src/shared/domain";

import { Timeline } from "../../src/client/components/Timeline";

// @vitest-environment jsdom

const REQUEST: UserInputRequestItem = {
  kind: "user_input",
  stage: "request",
  id: "user-input-10",
  ordinal: 10,
  timestamp: null,
  callId: "call-choice",
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Which option should be used?",
      options: [
        { label: "First", description: "Use the first approach." },
        { label: "Second", description: "Use the second approach." },
      ],
    },
  ],
};

describe("user input timeline cards", () => {
  it("rewrites the pending request card in place when its answer is loaded", () => {
    const { rerender } = renderTimeline([REQUEST]);
    const pendingCard = screen.getByText("Waiting").closest("article");
    expect(pendingCard).not.toBeNull();
    expect(screen.getByText("Use the second approach.")).toBeInTheDocument();

    rerender(timeline([REQUEST, answered(["Second", "A custom answer"])]));

    const answeredCard = screen.getByText("Answered").closest("article");
    expect(answeredCard).toBe(pendingCard);
    expect(screen.getAllByText(/User input ·/)).toHaveLength(1);
    expect(within(answeredCard!).getByText("Second").closest("li")).toHaveClass("selected");
    expect(within(answeredCard!).getByText("A custom answer")).toBeInTheDocument();
  });

  it("retains all options and marks an aborted request", () => {
    renderTimeline([REQUEST, response({ outcome: "aborted" })]);

    const card = screen.getByText("Aborted").closest("article")!;
    expect(within(card).getByText("First")).toBeInTheDocument();
    expect(within(card).getByText("Second")).toBeInTheDocument();
    expect(within(card).queryByText("Selected")).toBeNull();
  });

  it("shows an unmatched response at its own ordinal instead of dropping it", () => {
    renderTimeline([answered(["Second"])]);

    expect(screen.getByText("Request details unavailable.")).toBeInTheDocument();
    expect(screen.getByText("choice")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });
});

function answered(answers: string[]): UserInputItem {
  return response({
    outcome: "answered",
    answers: [{ questionId: "choice", answers }],
  });
}

function response(
  result:
    | { outcome: "answered"; answers: { questionId: string; answers: string[] }[] }
    | { outcome: "aborted" },
): UserInputItem {
  return {
    kind: "user_input",
    stage: "response",
    id: "user-input-11",
    ordinal: 11,
    timestamp: null,
    callId: "call-choice",
    ...result,
  };
}

function renderTimeline(items: UserInputItem[]) {
  return render(timeline(items));
}

function timeline(items: UserInputItem[]) {
  return (
    <Timeline
      items={items}
      sessionId="session"
      cursor={"opaque.timeline.cursor" as TimelineCursor}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
    />
  );
}

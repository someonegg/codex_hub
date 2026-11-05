import type { TimelineItem, UserInputQuestion } from "../../../shared/domain.js";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function normalizeQuestions(
  callId: string,
  values: readonly unknown[],
): UserInputQuestion[] {
  return values.flatMap((value, index): UserInputQuestion[] => {
    if (!object(value) || typeof value.question !== "string") return [];
    const options: Array<UserInputQuestion["options"][number]> = [];
    if (Array.isArray(value.options)) {
      for (const option of value.options) {
        if (!object(option) || typeof option.label !== "string") continue;
        options.push({ label: option.label, description: string(option.description) ?? "" });
      }
    }
    return [
      {
        id: `${callId}:${index}`,
        header: string(value.header) ?? "",
        question: value.question,
        options,
      },
    ];
  });
}

type NewResponse<T = Extract<TimelineItem, { kind: "user_input"; stage: "response" }>> =
  T extends TimelineItem ? Omit<T, "id" | "ordinal"> : never;

export function normalizeQuestionResponse(
  callId: string,
  questions: readonly UserInputQuestion[],
  content: unknown,
  toolUseResult: unknown,
  timestamp: string | null,
): NewResponse {
  let result: unknown = content;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      /* Unstructured results are unavailable unless explicitly rejected. */
    }
  }
  let structured: ObjectValue | null = null;
  if (object(toolUseResult)) structured = toolUseResult;
  else if (object(result)) structured = result;
  const values = structured && object(structured.answers) ? structured.answers : null;
  const answers = questions.map((q) => {
    const answer = values?.[q.question] ?? values?.[q.id];
    let answerValues: string[] = [];
    if (typeof answer === "string") answerValues = [answer];
    else if (Array.isArray(answer) && answer.every((v) => typeof v === "string"))
      answerValues = [...answer];
    return { questionId: q.id, answers: answerValues };
  });
  const rejected =
    structured?.denied === true ||
    structured?.rejected === true ||
    (typeof result === "string" &&
      /^(?:The user (?:doesn't want to proceed|declined|rejected)|User (?:declined|rejected)|Request interrupted by user)/i.test(
        result,
      ));
  const response = {
    kind: "user_input",
    stage: "response",
    callId,
    timestamp,
  } as const;
  if (rejected) return { ...response, outcome: "aborted" };
  else if (answers.length > 0 && answers.every((a) => a.answers.length > 0))
    return { ...response, outcome: "answered", answers };
  else
    return {
      ...response,
      outcome: "unavailable",
      summary: "Answer could not be reliably interpreted",
    };
}

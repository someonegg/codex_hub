import { useTranslation } from "react-i18next";

import type {
  UserInputAnswer,
  UserInputItem as UserInputTimelineItem,
  UserInputRequestItem,
} from "../../shared/domain";

import { t } from "../i18n";
import { EventTime } from "./EventTime";

type UserInputResponseItem = Exclude<UserInputTimelineItem, { stage: "request" }>;

export interface UserInputCardEntry {
  kind: "user_input";
  id: string;
  ordinal: number;
  timestamp: string | null;
  request: UserInputRequestItem | null;
  response: UserInputResponseItem | null;
}

export function UserInputItem({ entry }: { entry: UserInputCardEntry }) {
  useTranslation();
  const answers =
    entry.response?.outcome === "answered"
      ? new Map(entry.response.answers.map((answer) => [answer.questionId, answer]))
      : new Map<string, UserInputAnswer>();
  const knownQuestionIds = new Set(entry.request?.questions.map((question) => question.id) ?? []);
  const unmatchedAnswers = [...answers.values()].filter(
    (answer) => !knownQuestionIds.has(answer.questionId),
  );

  return (
    <article className="user-input-card">
      <div className="user-input-heading">
        <p className="event-label">
          {t("userInput")} {entry.ordinal}
          <EventTime timestamp={entry.timestamp} />
        </p>
        <span className={`user-input-status ${statusClass(entry.response)}`}>
          {statusLabel(entry.response)}
        </span>
      </div>
      {entry.request === null || entry.request.questions.length === 0 ? (
        <p className="user-input-unavailable">{t("requestDetailsUnavailable")}</p>
      ) : (
        entry.request.questions.map((question) => (
          <section className="user-input-question" key={question.id}>
            <p className="user-input-header">{question.header}</p>
            <h3>{question.question}</h3>
            <OptionList
              options={question.options}
              answer={answers.get(question.id) ?? null}
              answered={entry.response?.outcome === "answered"}
            />
          </section>
        ))
      )}
      {unmatchedAnswers.length > 0 ? <RecordedAnswers answers={unmatchedAnswers} /> : null}
      {entry.response?.outcome === "unavailable" ? (
        <p className="user-input-unavailable">{entry.response.summary}</p>
      ) : null}
    </article>
  );
}

function OptionList({
  options,
  answer,
  answered,
}: {
  options: UserInputRequestItem["questions"][number]["options"];
  answer: UserInputAnswer | null;
  answered: boolean;
}) {
  useTranslation();
  const selected = new Set(answer?.answers ?? []);
  const labels = new Set(options.map((option) => option.label));
  const freeform = (answer?.answers ?? []).filter((value) => !labels.has(value));
  return (
    <>
      <ul className="user-input-options">
        {options.map((option) => {
          const isSelected = selected.has(option.label);
          return (
            <li className={isSelected ? "selected" : undefined} key={option.label}>
              <div>
                <strong>{option.label}</strong>
                <p>{option.description}</p>
              </div>
              {isSelected ? <span className="selected-marker">{t("selected")}</span> : null}
            </li>
          );
        })}
      </ul>
      {freeform.length > 0 ? (
        <div className="user-input-freeform">
          <span>{t("recordedAnswer")}</span>
          {freeform.map((value, index) => (
            <p key={`${index}:${value}`}>{value}</p>
          ))}
        </div>
      ) : answered && (answer === null || answer.answers.length === 0) ? (
        <p className="user-input-unavailable">{t("noAnswerRecorded")}</p>
      ) : null}
    </>
  );
}

function RecordedAnswers({ answers }: { answers: UserInputAnswer[] }) {
  useTranslation();
  return (
    <section className="user-input-question user-input-unmatched">
      <p className="user-input-header">{t("recordedAnswers")}</p>
      {answers.map((answer) => (
        <div className="user-input-freeform" key={answer.questionId}>
          <span>{answer.questionId}</span>
          {answer.answers.length === 0 ? (
            <p>{t("noAnswerRecorded")}</p>
          ) : (
            answer.answers.map((value, index) => <p key={`${index}:${value}`}>{value}</p>)
          )}
        </div>
      ))}
    </section>
  );
}

function statusLabel(response: UserInputResponseItem | null): string {
  if (response === null) return t("waiting");
  if (response.outcome === "answered") return t("answered");
  if (response.outcome === "aborted") return t("aborted");
  return t("unavailable");
}

function statusClass(response: UserInputResponseItem | null): string {
  return response === null ? "pending" : response.outcome;
}

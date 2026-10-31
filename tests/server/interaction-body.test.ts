import { expect, it } from "vitest";

import { RequestBodyError } from "../../src/server/http/request-body.js";
import {
  parseKeysBody,
  parseMessageBody,
} from "../../src/server/http/session-interaction-routes.js";
import { MessageValidationError } from "../../src/server/interaction/message.js";
import { INTERACTION_KEYS } from "../../src/shared/api-contract.js";

it.each([{ message: 1 }, { message: "ok", requireIdle: "yes" }])(
  "rejects invalid message body structure %j",
  (body) => {
    expect(() => parseMessageBody(body)).toThrow(RequestBodyError);
    expect(() => parseMessageBody(body)).toThrow("body must contain only a string message field");
  },
);
it("validates message bytes after structure without changing the transmitted text", () => {
  const body = { message: "a\r\nb", requireIdle: false };
  expect(parseMessageBody(body)).toEqual(body);
  expect(parseMessageBody({ message: "a".repeat(262_144) }).message).toHaveLength(262_144);
  expect(() => parseMessageBody({ message: "a".repeat(262_145) })).toThrow(MessageValidationError);
  expect(() => parseMessageBody({ message: " \n " })).toThrow(MessageValidationError);
  expect(() => parseMessageBody({ message: " ", extra: true })).toThrow(RequestBodyError);
});
it.each([
  { keys: "enter" },
  { keys: ["enter"], extra: true },
  { keys: [] },
  { keys: ["unknown"] },
  { keys: Array.from({ length: 65 }, () => "left") },
  { keys: ["interrupt"], requireIdle: true },
])("rejects invalid keys body %j", (body) => {
  expect(() => parseKeysBody(body)).toThrow(RequestBodyError);
});
it("accepts all supported keys and the sequence boundary with optional idle requirements", () => {
  expect(parseKeysBody({ keys: [...INTERACTION_KEYS] })).toEqual({ keys: [...INTERACTION_KEYS] });
  const body = { keys: Array.from({ length: 64 }, () => "left"), requireIdle: true };
  expect(parseKeysBody(body)).toEqual(body);
  expect(parseKeysBody({ keys: ["interrupt"], requireIdle: false })).toEqual({
    keys: ["interrupt"],
    requireIdle: false,
  });
});
it("checks keys structure before sequence contents and idle restrictions", () => {
  expect(() => parseKeysBody({ keys: ["unknown"], requireIdle: "yes" })).toThrow(
    "body must contain only a keys array",
  );
  expect(() => parseKeysBody({ keys: ["unknown", "interrupt"], requireIdle: true })).toThrow(
    "keys must contain 1-64 supported interaction keys",
  );
});

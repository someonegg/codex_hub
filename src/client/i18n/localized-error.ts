import type { PlainMessageKey } from "./index";
import { en } from "./messages";

/** Retain a semantic key until render, including while a notification is visible. */
export class LocalizedError extends Error {
  constructor(public readonly key: PlainMessageKey) {
    super(en[key]);
    this.name = "LocalizedError";
  }
}

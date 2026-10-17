export const MAX_INTERACTION_MESSAGE_BYTES = 64 * 1024;
export const MAX_INTERACTION_KEY_SEQUENCE_LENGTH = 64;

export const INTERACTION_KEYS = [
  "enter",
  "up",
  "down",
  "left",
  "right",
  "interrupt",
  "plan",
] as const;

export type InteractionKey = (typeof INTERACTION_KEYS)[number];

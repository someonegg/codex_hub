export const MAX_INTERACTION_MESSAGE_BYTES = 256 * 1024;
export const MAX_INTERACTION_KEY_SEQUENCE_LENGTH = 64;

export const INTERACTION_KEYS = [
  "enter",
  "up",
  "down",
  "left",
  "right",
  "interrupt",
  "plan",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
] as const;

export type InteractionKey = (typeof INTERACTION_KEYS)[number];

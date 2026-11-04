import type { SessionMessagesResponse } from "../../shared/api-contract";
export type ReaderContext = Omit<SessionMessagesResponse, "items" | "interaction" | "live">;

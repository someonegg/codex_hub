import type { SessionDetail } from "../shared/domain";

export function sessionDisplayTitle(session: Pick<SessionDetail, "title" | "nickname">): string {
  return session.nickname ?? session.title;
}

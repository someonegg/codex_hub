import { createContext, type ReactNode, useContext, useState } from "react";

function useDraftStore() {
  return useState(() => new Map<string, { text: string }>());
}

const SessionDraftContext = createContext<ReturnType<typeof useDraftStore> | null>(null);

export function SessionDraftProvider({ children }: { children: ReactNode }) {
  const store = useDraftStore();
  return <SessionDraftContext value={store}>{children}</SessionDraftContext>;
}

export function useSessionDraft(sessionId: string) {
  const localStore = useDraftStore();
  const [drafts, setDrafts] = useContext(SessionDraftContext) ?? localStore;
  const draft = drafts.get(sessionId);
  const message = draft?.text ?? "";
  const setMessage = (text: string) => {
    setDrafts((current) => {
      const next = new Map(current);
      if (text) next.set(sessionId, { text });
      else next.delete(sessionId);
      return next;
    });
  };
  const clearSentMessage = () => {
    setDrafts((current) => {
      // Compare edit identity, not text: a newer draft may contain the same text.
      if (current.get(sessionId) !== draft) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  };
  return { message, setMessage, clearSentMessage };
}

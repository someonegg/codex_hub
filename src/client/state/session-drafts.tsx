import { createContext, type ReactNode, useContext, useState } from "react";

export interface DraftAttachment {
  id: string;
  file: File;
  path: string;
}

interface SessionDraft {
  text: string;
  attachments: DraftAttachment[];
}

function useDraftStore() {
  return useState(() => new Map<string, SessionDraft>());
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
  const attachments = draft?.attachments ?? [];
  const updateDraft = (update: (current: SessionDraft) => SessionDraft) => {
    setDrafts((current) => {
      const next = new Map(current);
      const updated = update(current.get(sessionId) ?? { text: "", attachments: [] });
      if (updated.text || updated.attachments.length) next.set(sessionId, updated);
      else next.delete(sessionId);
      return next;
    });
  };
  const setMessage = (text: string) => updateDraft((current) => ({ ...current, text }));
  const addAttachment = (attachment: DraftAttachment) =>
    updateDraft((current) => ({ ...current, attachments: [...current.attachments, attachment] }));
  const removeAttachment = (id: string) =>
    updateDraft((current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
  const clearSentMessage = () => {
    setDrafts((current) => {
      // Compare edit identity, not text: a newer draft may contain the same text.
      if (current.get(sessionId) !== draft) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  };
  return { message, setMessage, attachments, addAttachment, removeAttachment, clearSentMessage };
}

import { useCallback, useEffect, useRef, useState } from "react";

import type { InteractionKey } from "../../shared/api-contract";

import { api } from "../api/client";
import { messageFor } from "./request-errors";

export function useSessionInteraction(sessionId: string) {
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionId = useRef(sessionId);
  const generation = useRef(0);
  const mounted = useRef(true);
  const writing = useRef(false);

  if (activeSessionId.current !== sessionId) {
    activeSessionId.current = sessionId;
    generation.current += 1;
    writing.current = false;
  }

  useEffect(() => {
    setError(null);
    setInteractionBusy(false);
  }, [sessionId]);

  const act = useCallback(async (operation: () => Promise<void>) => {
    if (!mounted.current || writing.current)
      throw new Error("An interaction is already in progress.");
    writing.current = true;
    const operationGeneration = ++generation.current;
    setInteractionBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current && generation.current === operationGeneration) {
        setError(messageFor(reason));
      }
      throw reason;
    } finally {
      if (generation.current === operationGeneration) writing.current = false;
      if (mounted.current && generation.current === operationGeneration) {
        setInteractionBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  return {
    interactionBusy,
    error,
    clearError: () => setError(null),
    sendMessage: (message: string) => act(() => api.sendMessage(sessionId, message)),
    rebind: () => act(() => api.rebind(sessionId)),
    sendKeys: (keys: readonly InteractionKey[]) => act(() => api.sendKeys(sessionId, keys)),
  };
}

import type { InteractionResponse } from "../../shared/api-contract";

import { useSessionInteraction } from "../state/use-session-interaction";
import { useTerminalPreview } from "../state/use-terminal-preview";
import { InteractionPanel } from "./InteractionPanel";

interface SessionInteractionProps {
  interaction: InteractionResponse | null;
  onNavigate?: (sessionId: string) => void;
  sessionId: string;
  itemCount: number;
  updatedAt: string | null;
  previewAutoExpandKey?: string | null;
}

export function SessionInteraction({
  interaction,
  onNavigate,
  sessionId,
  itemCount,
  updatedAt,
  previewAutoExpandKey = null,
}: SessionInteractionProps) {
  const previewAvailable = interaction?.supported === true && interaction.state === "connected";
  const controller = useSessionInteraction(sessionId);

  const preview = useTerminalPreview(sessionId, previewAvailable, previewAutoExpandKey);

  return (
    <InteractionPanel
      interaction={interaction}
      onNavigate={onNavigate}
      itemCount={itemCount}
      updatedAt={updatedAt}
      interactionBusy={controller.interactionBusy}
      error={controller.error}
      onDismissError={controller.clearError}
      onSendMessage={controller.sendMessage}
      onSendKeys={controller.sendKeys}
      onHandoffPaneBinding={controller.handoffPaneBinding}
      {...preview}
    />
  );
}

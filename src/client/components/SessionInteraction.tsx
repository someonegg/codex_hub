import type { ReactNode } from "react";

import type { InteractionResponse } from "../../shared/api-contract";

import { useSessionInteraction } from "../state/use-session-interaction";
import { useTerminalPreview } from "../state/use-terminal-preview";
import { InteractionPanel } from "./InteractionPanel";

interface SessionInteractionProps {
  onPanelElement?: (element: HTMLElement | null) => void;
  recoveryActions?: ReactNode;
  operationStatus?: ReactNode;
  managementBusy?: boolean;
  interaction: InteractionResponse | null;
  onNavigate?: (sessionId: string) => void;
  sessionId: string;
  itemCount: number;
  updatedAt: string | null;
  previewAutoExpandKey?: string | null;
}

export function SessionInteraction({
  onPanelElement,
  recoveryActions,
  operationStatus,
  managementBusy,
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
      key={sessionId}
      sessionId={sessionId}
      onPanelElement={onPanelElement}
      recoveryActions={recoveryActions}
      operationStatus={operationStatus}
      interaction={interaction}
      onNavigate={onNavigate}
      itemCount={itemCount}
      updatedAt={updatedAt}
      interactionBusy={controller.interactionBusy || !!managementBusy}
      error={controller.error}
      errorDetail={controller.errorDetail}
      onDismissError={controller.clearError}
      onSendMessage={controller.sendMessage}
      onSendKeys={controller.sendKeys}
      onHandoffPaneBinding={controller.handoffPaneBinding}
      {...preview}
    />
  );
}

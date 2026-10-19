import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { TmuxBinding } from "../interaction/transport.js";
import type { SessionExitCapability, SessionExitStep } from "./session-manager.js";

type ExitInteraction = Pick<
  SessionInteractionService,
  "inspectTarget" | "sendExitKeys" | "killTarget"
>;

/** A caller-owned task: advance it serially and stop advancing it when cancelled. */
export interface SessionExitTask {
  readonly phase: "sending_exit" | "waiting_exit";
  advance(): Promise<boolean>;
}

export class SessionExitService {
  constructor(
    private readonly interaction: ExitInteraction,
    private readonly now = Date.now,
    private readonly timing = { eofDelayMs: 4_000, killDelayMs: 9_000 },
  ) {}

  start(
    sessionId: string,
    target: TmuxBinding,
    capability: SessionExitCapability,
    assertActive: () => void,
  ): SessionExitTask {
    const steps: readonly SessionExitStep[] = [
      ...capability.exitSteps().map((step) => ({ ...step, keys: [...step.keys] })),
      { keys: ["C-d"], delayMs: this.timing.eofDelayMs },
    ];
    let index = 0;
    let due = this.now() + steps[0]!.delayMs;
    let killed = false;
    let phase: SessionExitTask["phase"] = "sending_exit";
    return {
      get phase() {
        return phase;
      },
      advance: async () => {
        assertActive();
        const state = await this.interaction.inspectTarget(target, sessionId);
        assertActive();
        if (state === "exited") return true;
        if (this.now() < due || killed) return false;
        const step = steps[index];
        if (step) {
          await this.interaction.sendExitKeys(target, sessionId, step.keys, assertActive);
          assertActive();
          index++;
          phase = index < steps.length - 1 ? "sending_exit" : "waiting_exit";
          due = this.now() + (steps[index]?.delayMs ?? this.timing.killDelayMs);
        } else {
          // Claim before awaiting: an uncertain kill is never retried.
          killed = true;
          await this.interaction.killTarget(target, sessionId, assertActive);
          assertActive();
        }
        return false;
      },
    };
  }
}

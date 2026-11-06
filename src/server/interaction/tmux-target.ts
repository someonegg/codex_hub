/** Hub sessions have exactly one window and pane; topology is a user contract. */
export function validTmuxSessionName(value: string): boolean {
  return /^ahub-[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(value);
}

/** A trailing colon disambiguates session names for both session and pane commands. */
export function tmuxTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

/** Only unix sockets owned by the current user may be controlled. */
export function ownedSocket(stats: { isSocket(): boolean; uid: number }): boolean {
  return stats.isSocket() && typeof process.getuid === "function" && stats.uid === process.getuid();
}

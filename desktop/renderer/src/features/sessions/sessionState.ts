export function isSessionRunning(state: DesktopState, sessionId?: string) {
  return Boolean(sessionId && state.runningSessionIds.includes(sessionId));
}

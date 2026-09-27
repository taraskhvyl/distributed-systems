// The on-page log: a tiny observable store (Observer pattern), so any module can log and
// the LogSheet component re-renders. Newest line first; capped so a long session can't grow it forever.
const MAX_LINES = 500

let lines: string[] = []
const listeners = new Set<() => void>()

export function log(message: string) {
  lines = [`${new Date().toLocaleTimeString()} ${message}`, ...lines].slice(0, MAX_LINES)
  for (const listener of listeners) listener()
}

/** For React's useSyncExternalStore. */
export function subscribeToLog(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLogLines() {
  return lines
}

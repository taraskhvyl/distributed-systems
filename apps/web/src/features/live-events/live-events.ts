// Keeps one SSE connection to the notifier open while the user is logged in.
import { API_URL } from '@/config'
import { accessToken, isLoggedIn } from '@/features/auth/token-store'
import { log } from '@/features/log/log-store'
import { readSseStream, type SseHandler } from './sse-parser'

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

interface LiveEventsOptions {
  /** Called after every (re)connect; events missed while disconnected are not replayed,
   *  so the caller resyncs its state here. */
  onConnected: () => void
  onEvent: SseHandler
  /** Stops the loop and closes the stream (React effect cleanup, logout). */
  signal: AbortSignal
}

/**
 * Connect, read events, reconnect: forever, until logout or abort.
 *
 * Why fetch() and not EventSource: EventSource can't send an Authorization header
 * (only cookies). fetch() can, and its body is a readable stream.
 */
export async function keepLiveEventsConnected({ onConnected, onEvent, signal }: LiveEventsOptions) {
  let backoffMs = INITIAL_BACKOFF_MS
  const shouldStayConnected = () => isLoggedIn() && !signal.aborted

  while (shouldStayConnected()) {
    try {
      await streamOnce({ onConnected, onEvent, signal })
      backoffMs = INITIAL_BACKOFF_MS
      // A clean end means the server cut us off at the token's expiry. Reconnect now:
      // accessToken() will hand us a refreshed token.
      log('live events closed by server (token expiry), reconnecting')
    } catch (err) {
      if (!shouldStayConnected()) return
      const waitMs = withJitter(backoffMs)
      log(`${(err as Error).message}; retrying in ${(waitMs / 1000).toFixed(1)}s`)
      await sleep(waitMs)
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}

async function streamOnce({ onConnected, onEvent, signal }: LiveEventsOptions) {
  const res = await fetch(`${API_URL}/events`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`live events: HTTP ${res.status}`)
  log('live events connected')
  onConnected()
  await readSseStream(res.body, onEvent)
}

// Randomize each wait (50%..150%) so many clients don't reconnect in lockstep
// after a notifier restart (thundering herd).
function withJitter(ms: number) {
  return ms * (0.5 + Math.random())
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

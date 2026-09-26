// Keeps one SSE connection to the notifier open while the user is logged in.
import { API_URL } from './config.js'
import { accessToken, isLoggedIn } from './auth.js'
import { log } from './log.js'
import { readSseStream } from './sse-parser.js'

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

/**
 * Connect, read events, reconnect: forever, until logout.
 *
 * Why fetch() and not EventSource: EventSource can't send an Authorization header
 * (only cookies). fetch() can, and its body is a readable stream.
 *
 * @param onConnected called after every (re)connect; events missed while disconnected
 *   are not replayed, so the caller resyncs its state here
 * @param onEvent called with (eventName, data) for each event
 */
export async function keepLiveEventsConnected({ onConnected, onEvent }) {
  let backoffMs = INITIAL_BACKOFF_MS

  while (isLoggedIn()) {
    try {
      await streamOnce({ onConnected, onEvent })
      backoffMs = INITIAL_BACKOFF_MS
      // A clean end means the server cut us off at the token's expiry. Reconnect now:
      // accessToken() will hand us a refreshed token.
      log('live events closed by server (token expiry), reconnecting')
    } catch (err) {
      if (!isLoggedIn()) return
      const waitMs = withJitter(backoffMs)
      log(`${err.message}; retrying in ${(waitMs / 1000).toFixed(1)}s`)
      await sleep(waitMs)
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}

async function streamOnce({ onConnected, onEvent }) {
  const res = await fetch(`${API_URL}/events`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  })
  if (!res.ok) throw new Error(`live events: HTTP ${res.status}`)
  log('live events connected')
  onConnected()
  await readSseStream(res.body, onEvent)
}

// Randomize each wait (50%..150%) so many clients don't reconnect in lockstep
// after a notifier restart (thundering herd).
function withJitter(ms) {
  return ms * (0.5 + Math.random())
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

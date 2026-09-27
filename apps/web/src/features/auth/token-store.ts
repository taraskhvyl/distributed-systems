// The tokens of the logged-in user and their lifecycle: store, refresh, notify.
// Used on every api request (accessToken). How we GET tokens is login-flow.ts.
import * as keycloak from '@/adapters/keycloak'
import { TOKEN_REFRESH_MARGIN_MS } from '@/config'
import { log } from '@/features/log/log-store'

interface Tokens {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
}

// Tokens live only in memory. Not localStorage: any XSS could read that and keep it.
// Cost: a page reload loses them, so main.tsx starts a silent login (`prompt=none`), which
// bounces through Keycloak and back without a click while Keycloak's SSO cookie is valid.
let tokens: Tokens | null = null
let refreshInFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

/** Observer: `listener()` runs whenever the user logs in or the session ends. */
export function onSessionChange(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isLoggedIn() {
  return tokens !== null
}

export function currentUsername(): string | null {
  return tokens ? decodeJwtPayload(tokens.accessToken).preferred_username : null
}

export function idToken() {
  return tokens?.idToken
}

/** Stores freshly issued tokens (after login) and tells the listeners. */
export function startSession(response: keycloak.TokenResponse) {
  store(response)
  notifyListeners()
}

export function endSession() {
  tokens = null
  notifyListeners()
}

/**
 * Returns a valid access token, refreshing it first if it is about to expire.
 * Refreshing at use time (not on a timer) is reliable even when background tabs throttle
 * timers or the laptop sleeps. Concurrent callers share one refresh request.
 */
export async function accessToken(): Promise<string> {
  if (!tokens) throw new Error('not logged in')
  const expiresSoon = Date.now() >= tokens.expiresAt - TOKEN_REFRESH_MARGIN_MS
  if (!expiresSoon) return tokens.accessToken

  refreshInFlight ??= refresh().finally(() => {
    refreshInFlight = null
  })
  await refreshInFlight
  if (!tokens) throw new Error('session ended')
  return tokens.accessToken
}

async function refresh() {
  try {
    store(await keycloak.refreshTokens(tokens!.refreshToken))
    log('access token refreshed')
  } catch (err) {
    endSession() // the refresh token expired too: the user must log in again
    throw err
  }
}

function store(response: keycloak.TokenResponse) {
  tokens = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    idToken: response.idToken,
    expiresAt: Date.now() + response.expiresInSeconds * 1000,
  }
}

function notifyListeners() {
  for (const listener of listeners) listener()
}

function decodeJwtPayload(jwt: string) {
  const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(base64))
}

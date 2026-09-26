// OAuth 2.0 Authorization Code flow with PKCE, written by hand (no library) to show the mechanics.
import { AUTH_URL, CLIENT_ID, REDIRECT_URI, TOKEN_REFRESH_MARGIN_MS } from './config.js'
import { log } from './log.js'

const PKCE_STORAGE_KEY = 'pkce'

// Tokens live only in memory. Not localStorage: any XSS could read that and keep it.
// Cost: a page reload loses them and login bounces through Keycloak again
// (instant while Keycloak's SSO cookie is valid).
let session = null // { accessToken, refreshToken, idToken, expiresAt }
let refreshInFlight = null
const sessionListeners = new Set()

/** Observer: `listener()` runs whenever the user logs in or the session ends. */
export function onSessionChange(listener) {
  sessionListeners.add(listener)
}

export function isLoggedIn() {
  return session !== null
}

export function currentUsername() {
  return session ? decodeJwtPayload(session.accessToken).preferred_username : null
}

/** Step 1: redirect to Keycloak with a fresh PKCE challenge and CSRF state. */
export async function login() {
  // The verifier is the one-time secret. Only its SHA-256 (the challenge) goes into the URL,
  // so a code intercepted from the URL can't be redeemed without the verifier.
  const verifier = randomUrlSafeString()
  const state = randomUrlSafeString() // ties the callback to the login this tab started
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))

  // sessionStorage, not memory: the full-page redirect wipes JS state. Read once, then deleted.
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, state }))

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  location.assign(`${AUTH_URL}/auth?${params}`)
}

/** Step 2: on return from Keycloak, check `state` and exchange the code plus verifier for tokens. */
export async function completeLoginRedirect() {
  const params = new URLSearchParams(location.search)
  const isLoginCallback = params.has('code') || params.has('error')
  if (!isLoginCallback) return

  const saved = JSON.parse(sessionStorage.getItem(PKCE_STORAGE_KEY) ?? 'null')
  sessionStorage.removeItem(PKCE_STORAGE_KEY)
  history.replaceState(null, '', '/') // drop ?code= from the address bar and history

  if (params.has('error')) throw new Error(`login failed: ${params.get('error')}`)
  if (!saved || params.get('state') !== saved.state) throw new Error('state mismatch, login rejected')

  await requestTokens({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: REDIRECT_URI,
    code_verifier: saved.verifier,
  })
  log('logged in (code exchanged with PKCE verifier)')
  notifySessionListeners()
}

/**
 * Returns a valid access token, refreshing it first if it is about to expire.
 * Refreshing at use time (not on a timer) is reliable even when background tabs throttle
 * timers or the laptop sleeps. Concurrent callers share one refresh request.
 */
export async function accessToken() {
  if (!session) throw new Error('not logged in')
  const expiresSoon = Date.now() >= session.expiresAt - TOKEN_REFRESH_MARGIN_MS
  if (!expiresSoon) return session.accessToken

  refreshInFlight ??= refreshSession().finally(() => {
    refreshInFlight = null
  })
  await refreshInFlight
  return session.accessToken
}

export function logout() {
  const idToken = session?.idToken
  session = null
  const params = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: REDIRECT_URI })
  if (idToken) params.set('id_token_hint', idToken)
  location.assign(`${AUTH_URL}/logout?${params}`)
}

async function refreshSession() {
  try {
    await requestTokens({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
    log('access token refreshed')
  } catch (err) {
    session = null // refresh token expired too: the user must log in again
    notifySessionListeners()
    throw err
  }
}

async function requestTokens(form) {
  const res = await fetch(`${AUTH_URL}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
  })
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`)
  const body = await res.json()
  session = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  }
}

function notifySessionListeners() {
  for (const listener of sessionListeners) listener()
}

function randomUrlSafeString() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

function base64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeJwtPayload(jwt) {
  const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(base64))
}

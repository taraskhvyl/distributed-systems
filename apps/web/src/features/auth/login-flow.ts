// Getting tokens: OAuth 2.0 Authorization Code flow with PKCE, written by hand (no library)
// to show the mechanics. Two full-page redirects: to Keycloak (login) and back (callback).
// Keycloak's endpoints: adapters/keycloak.ts. Where tokens live afterwards: token-store.ts.
import * as keycloak from '@/adapters/keycloak'
import { log } from '@/features/log/log-store'
import { challengeFor, randomUrlSafeString } from './pkce'
import { idToken, startSession } from './token-store'

const PENDING_LOGIN_KEY = 'pkce'
// What Keycloak answers to `prompt=none` when it would have to show a page: no SSO session
// (login_required) or a screen the user must see. Normal outcome, not a failure.
const SILENT_LOGIN_UNAVAILABLE = new Set(['login_required', 'interaction_required', 'consent_required'])

interface PendingLogin {
  verifier: string
  state: string
  silent: boolean
}

/** True when this page load is Keycloak redirecting back to us (with a code or an error). */
export function isLoginCallback() {
  const params = new URLSearchParams(location.search)
  return params.has('code') || params.has('error')
}

/**
 * Step 1: redirect to Keycloak with a fresh PKCE challenge and CSRF state.
 * `silent`: adds `prompt=none`, i.e. "log me in only if you already know me (SSO cookie),
 * never show a form". Used on page load, because a reload wipes the in-memory tokens.
 */
export async function login({ silent = false } = {}) {
  const verifier = randomUrlSafeString()
  const state = randomUrlSafeString() // ties the callback to the login this tab started
  const challenge = await challengeFor(verifier)
  savePendingLogin({ verifier, state, silent })
  location.assign(keycloak.authorizeUrl({ state, challenge, silent }))
}

/** Step 2: on return from Keycloak, check `state` and exchange the code plus verifier for tokens. */
export async function completeLoginRedirect() {
  if (!isLoginCallback()) return
  const params = new URLSearchParams(location.search)
  const pending = takePendingLogin()
  history.replaceState(null, '', '/') // drop ?code= from the address bar and history

  const error = params.get('error')
  const noSsoSession = pending?.silent && error !== null && SILENT_LOGIN_UNAVAILABLE.has(error)
  if (noSsoSession) return // not logged in at Keycloak: show the Log in button
  if (error) throw new Error(`login failed: ${error}`)
  if (!pending || params.get('state') !== pending.state) throw new Error('state mismatch, login rejected')

  startSession(await keycloak.exchangeCode(params.get('code') ?? '', pending.verifier))
  log('logged in (code exchanged with PKCE verifier)')
}

/** Ends the Keycloak SSO session too, not only ours; Keycloak redirects back to the app. */
export function logout() {
  location.assign(keycloak.logoutUrl(idToken()))
}

// sessionStorage, not memory: the full-page redirect wipes JS state. Read once, then deleted.
function savePendingLogin(pending: PendingLogin) {
  sessionStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pending))
}

function takePendingLogin(): PendingLogin | null {
  const pending = JSON.parse(sessionStorage.getItem(PENDING_LOGIN_KEY) ?? 'null')
  sessionStorage.removeItem(PENDING_LOGIN_KEY)
  return pending
}

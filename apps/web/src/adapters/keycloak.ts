// Adapter for Keycloak's OpenID Connect endpoints: where to redirect, and the token exchange.
import { AUTH_URL, CLIENT_ID, REDIRECT_URI } from '@/config'

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresInSeconds: number
}

export function authorizeUrl({ state, challenge, silent }: { state: string; challenge: string; silent: boolean }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (silent) params.set('prompt', 'none')
  return `${AUTH_URL}/auth?${params}`
}

export function logoutUrl(idToken: string | undefined) {
  const params = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: REDIRECT_URI })
  if (idToken) params.set('id_token_hint', idToken)
  return `${AUTH_URL}/logout?${params}`
}

export function exchangeCode(code: string, verifier: string) {
  return requestTokens({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
}

export function refreshTokens(refreshToken: string) {
  return requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

async function requestTokens(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_URL}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
  })
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`)
  const body = await res.json()
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    expiresInSeconds: body.expires_in,
  }
}

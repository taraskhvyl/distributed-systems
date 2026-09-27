// PKCE (RFC 7636) helpers. The verifier is the one-time secret; only its SHA-256 (the
// challenge) goes into the URL, so a code intercepted from the URL can't be redeemed alone.
const RANDOM_BYTES = 32

export function randomUrlSafeString() {
  return base64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))
}

export async function challengeFor(verifier: string) {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

function base64Url(bytes: ArrayBuffer | Uint8Array) {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

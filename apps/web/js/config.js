export const AUTH_URL = 'https://auth.localhost/realms/media/protocol/openid-connect'
export const API_URL = 'https://api.localhost/v1'
export const CLIENT_ID = 'media-web'
export const REDIRECT_URI = `${location.origin}/`

/** Refresh the access token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000

const AUTH = 'https://auth.localhost/realms/media/protocol/openid-connect'
const API = 'https://api.localhost/v1'
const CLIENT_ID = 'media-web'
const REDIRECT_URI = `${location.origin}/`

const $ = (id) => document.getElementById(id)
const log = (msg) => { $('log').textContent = `${new Date().toLocaleTimeString()} ${msg}\n` + $('log').textContent }

// ---- auth: Authorization Code + PKCE, hand-written ------------------------------------

// Tokens live only in this variable. Not localStorage: any XSS could read that forever.
// Cost: a page reload loses them, and login bounces through Keycloak again
// (instant if its SSO cookie is still valid).
let tokens = null // { access_token, refresh_token, id_token, expiresAt }
let refreshing = null

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

async function login() {
  // The verifier is the secret; only its SHA-256 (the challenge) goes through the browser URL.
  // Whoever later redeems the code must present the verifier, so a stolen code is useless.
  const verifier = randomString()
  const state = randomString() // CSRF: ties the callback to the login we started
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  // sessionStorage (not memory) because the full-page redirect wipes JS state. Single-use.
  sessionStorage.setItem('pkce', JSON.stringify({ verifier, state }))
  location.assign(`${AUTH}/auth?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`)
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search)
  if (!params.has('code') && !params.has('error')) return
  const saved = JSON.parse(sessionStorage.getItem('pkce') ?? 'null')
  sessionStorage.removeItem('pkce')
  history.replaceState(null, '', '/') // drop ?code= from the URL bar and history
  if (params.has('error')) throw new Error(`login failed: ${params.get('error')}`)
  if (!saved || params.get('state') !== saved.state) throw new Error('state mismatch, login rejected')
  await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: REDIRECT_URI,
    code_verifier: saved.verifier,
  })
  log('logged in (code exchanged with PKCE verifier)')
}

async function tokenRequest(form) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
  })
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`)
  const body = await res.json()
  tokens = { ...body, expiresAt: Date.now() + body.expires_in * 1000 }
}

// Refresh lazily, just before expiry, instead of on a timer: background tabs throttle
// timers and laptops sleep, so a timer can fire late. Checking at use time can't.
// `refreshing` makes concurrent callers share one refresh request.
async function accessToken() {
  if (!tokens) throw new Error('not logged in')
  if (Date.now() < tokens.expiresAt - 30_000) return tokens.access_token
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    .then(() => log('access token refreshed'))
    .catch((err) => { tokens = null; render(); throw err })
    .finally(() => { refreshing = null })
  await refreshing
  return tokens.access_token
}

function logout() {
  const idToken = tokens?.id_token
  tokens = null
  location.assign(`${AUTH}/logout?${new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: REDIRECT_URI,
    ...(idToken && { id_token_hint: idToken }),
  })}`)
}

const claims = (jwt) => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))

// ---- api ------------------------------------------------------------------------------

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
  return res.status === 204 ? null : res.json()
}

// fetch() has no upload-progress events; XHR does (xhr.upload.onprogress).
function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`S3 PUT: HTTP ${xhr.status}`)))
    // A CORS rejection looks exactly like this: status 0, no details for JS. Check DevTools.
    xhr.onerror = () => reject(new Error('S3 PUT: network error (CORS? see DevTools console)'))
    xhr.send(file)
  })
}

async function upload(file) {
  const created = await api(
    'POST', '/files',
    { filename: file.name, contentType: file.type, sizeBytes: file.size },
    { 'Idempotency-Key': crypto.randomUUID() },
  )
  log(`registered ${created.file.id}, uploading to ${new URL(created.uploadUrl).host}`)
  $('progress').hidden = false
  await putWithProgress(created.uploadUrl, file, (p) => ($('progress').value = p))
  await api('POST', `/files/${created.file.id}/complete`)
  log(`upload complete: ${file.name}`)
  await refreshList()
}

async function download(id) {
  const { url } = await api('POST', `/files/${id}/download-url`)
  location.assign(url)
}

// ---- ui -------------------------------------------------------------------------------

async function refreshList() {
  const { files } = await api('GET', '/files?limit=50')
  // textContent only, never innerHTML: filenames are user input.
  $('files').replaceChildren(...files.map((f) => {
    const tr = document.createElement('tr')
    const img = document.createElement('img')
    if (f.thumbnailUrl) img.src = f.thumbnailUrl
    const btn = document.createElement('button')
    btn.textContent = 'Download'
    btn.disabled = f.status !== 'ready'
    btn.onclick = () => download(f.id).catch((e) => log(e.message))
    const cells = [img, f.filename, f.status, `${(f.sizeBytes / 1024).toFixed(1)} KB`, btn]
    tr.replaceChildren(...cells.map((c) => {
      const td = document.createElement('td')
      td.append(c)
      return td
    }))
    return tr
  }))
}

function render() {
  $('login').hidden = !!tokens
  $('logout').hidden = !tokens
  $('app').hidden = !tokens
  $('who').textContent = tokens ? claims(tokens.access_token).preferred_username : ''
}

$('login').onclick = () => login()
$('logout').onclick = () => logout()
$('refresh').onclick = () => refreshList().catch((e) => log(e.message))
$('file').onchange = (e) => {
  const file = e.target.files[0]
  if (file) upload(file).catch((err) => log(err.message)).finally(() => (e.target.value = ''))
}

try {
  await handleRedirect()
} catch (err) {
  log(err.message)
}
render()
if (tokens) refreshList().catch((e) => log(e.message))

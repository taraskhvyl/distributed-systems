// Phase 3 baseline: a mix of feed reads, likes and uploads, ramped to a fixed number of
// virtual users. Run with `make loadtest`. Goes through the gateway like a real client,
// so TLS, the gateway and the per-user token bucket are part of what's measured. Its network
// is exempt from per-IP limits (infra/ratelimit/config.yaml): k6 stands in for many clients.
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const API = 'https://api.localhost/v1'
const AUTH = 'https://auth.localhost'
const TOKEN_URL = `${AUTH}/realms/media/protocol/openid-connect/token`

// Test-only users created by setup(). Many users = many per-user token buckets, like real
// traffic; two users would just measure the bucket (run 1). The seeded demo users are never
// touched, so `make demo`'s exact assertions (e.g. alice has 1 follower) keep holding.
const LOADTEST_USER_COUNT = Number(__ENV.LOADTEST_USERS ?? 50)
const LOADTEST_PASSWORD = 'loadtest-pass'
const LOADTEST_USERNAMES = Array.from({ length: LOADTEST_USER_COUNT }, (_, i) => `loadtest-${String(i + 1).padStart(2, '0')}`)

const SAMPLE_PNG = open('/samples/sample.png', 'b')

const PEAK_VUS = Number(__ENV.VUS ?? 20)
const FEED_SHARE = 0.7
const LIKE_SHARE = 0.2 // the rest (10%) are uploads
const THINK_TIME_S = 1
const READY_TIMEOUT_S = 30

// Every response counted by status, so the summary shows 200s vs 429s vs 5xx.
const responses = new Counter('responses')

export const options = {
  insecureSkipTLSVerify: true, // the local CA (infra/gateway/certs) isn't in k6's trust store
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: PEAK_VUS },
        { duration: '60s', target: PEAK_VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
  // No pass/fail yet: thresholds are listed only so the summary breaks results down
  // per endpoint and per status code.
  thresholds: {
    'http_req_duration{name:feed}': ['p(95)>=0'],
    'http_req_duration{name:like}': ['p(95)>=0'],
    'http_req_duration{name:upload_register}': ['p(95)>=0'],
    'http_req_duration{name:upload_put}': ['p(95)>=0'],
    'http_req_duration{name:upload_complete}': ['p(95)>=0'],
    'responses{status:200}': ['count>=0'],
    'responses{status:201}': ['count>=0'],
    'responses{status:202}': ['count>=0'],
    'responses{status:429}': ['count>=0'],
    'responses{status:500}': ['count>=0'],
    'responses{status:502}': ['count>=0'],
    'responses{status:503}': ['count>=0'],
  },
}

/**
 * Runs once: create the loadtest users and get their tokens. The first user publishes one
 * file (the one everyone likes); all others follow it, so their feeds are not empty.
 * Tokens live 5 min (realm default); the whole run takes under 2.
 */
export function setup() {
  ensureLoadtestUsers()
  const tokens = LOADTEST_USERNAMES.map((username) => fetchToken(username, LOADTEST_PASSWORD))
  const [authorName] = LOADTEST_USERNAMES
  const [authorToken, ...followerTokens] = tokens

  const fileId = uploadFile(authorToken)
  waitUntilReady(authorToken, fileId)
  request('PATCH', `/files/${fileId}`, authorToken, 'publish', { visibility: 'public' })
  for (const token of followerTokens) request('PUT', `/users/${authorName}/follow`, token, 'follow')
  return { tokens, fileId }
}

export default function (data) {
  const token = data.tokens[__VU % data.tokens.length]
  const roll = Math.random()

  if (roll < FEED_SHARE) {
    request('GET', '/feed', token, 'feed')
  } else if (roll < FEED_SHARE + LIKE_SHARE) {
    request('PUT', `/files/${data.fileId}/like`, token, 'like')
    request('DELETE', `/files/${data.fileId}/like`, token, 'like')
  } else {
    uploadFile(token)
  }
  sleep(THINK_TIME_S)
}

function fetchToken(username, password) {
  const res = http.post(TOKEN_URL, { grant_type: 'password', client_id: 'media-cli', username, password })
  if (res.status !== 200) throw new Error(`token for ${username}: HTTP ${res.status}`)
  return res.json('access_token')
}

/**
 * Creates loadtest-01..N in the media realm via Keycloak's admin REST API. Idempotent:
 * 409 means the user already exists. They aren't in the realm JSON, so they vanish when
 * Keycloak is recreated and come back on the next run.
 */
function ensureLoadtestUsers() {
  const admin = http.post(`${AUTH}/realms/master/protocol/openid-connect/token`, {
    grant_type: 'password',
    client_id: 'admin-cli',
    username: 'admin',
    password: __ENV.KEYCLOAK_ADMIN_PASSWORD,
  })
  if (admin.status !== 200) throw new Error(`keycloak admin token: HTTP ${admin.status}`)
  const headers = { Authorization: `Bearer ${admin.json('access_token')}`, 'Content-Type': 'application/json' }

  for (const username of LOADTEST_USERNAMES) {
    // Email and names too: Keycloak's user profile requires them, or login fails with
    // "account is not fully set up".
    const user = {
      username,
      enabled: true,
      email: `${username}@localhost`,
      emailVerified: true,
      firstName: 'Load',
      lastName: username,
      credentials: [{ type: 'password', value: LOADTEST_PASSWORD, temporary: false }],
    }
    const res = http.post(`${AUTH}/admin/realms/media/users`, JSON.stringify(user), { headers })
    const createdOrExists = res.status === 201 || res.status === 409
    if (!createdOrExists) throw new Error(`create ${username}: HTTP ${res.status} ${res.body}`)
  }
}

/** register → PUT the bytes to the presigned URL → complete. Returns the file id (or null). */
function uploadFile(token) {
  const registered = request('POST', '/files', token, 'upload_register', {
    filename: 'loadtest.png',
    contentType: 'image/png',
    sizeBytes: SAMPLE_PNG.byteLength,
  })
  if (registered.status !== 201) return null

  const put = http.put(registered.json('uploadUrl'), SAMPLE_PNG, {
    headers: { 'Content-Type': 'image/png' },
    tags: { name: 'upload_put' },
  })
  record(put, 'upload_put', 200)
  if (put.status !== 200) return null

  const fileId = registered.json('file.id')
  request('POST', `/files/${fileId}/complete`, token, 'upload_complete')
  return fileId
}

function waitUntilReady(token, fileId) {
  for (let second = 0; second < READY_TIMEOUT_S; second++) {
    const res = request('GET', `/files/${fileId}`, token, 'setup_poll')
    if (res.json('file.status') === 'ready') return
    sleep(1)
  }
  throw new Error(`setup file ${fileId} was not ready within ${READY_TIMEOUT_S}s`)
}

function request(method, path, token, name, body) {
  const headers = { Authorization: `Bearer ${token}` }
  let payload = null
  // Only a request with a body may say it's JSON: Fastify rejects an empty JSON body (400).
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = http.request(method, `${API}${path}`, payload, { headers, tags: { name } })
  record(res, name)
  return res
}

function record(res, name, expectedStatus) {
  responses.add(1, { status: String(res.status), name })
  const isSuccess = expectedStatus === undefined ? res.status < 300 : res.status === expectedStatus
  check(res, { [`${name} ok`]: () => isSuccess })
}

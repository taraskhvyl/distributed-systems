// Phase 3 baseline: a mix of feed reads, likes and uploads, ramped to a fixed number of
// virtual users. Run with `make loadtest`. Goes through the gateway like a real client,
// so TLS, nginx rate limits and the per-user token bucket are part of what's measured.
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const API = 'https://api.localhost/v1'
const TOKEN_URL = 'https://auth.localhost/realms/media/protocol/openid-connect/token'

// Seeded dev users (infra/keycloak/media-realm.json), same defaults as tools/demo/client.py.
// Deliberately duplicated: k6 can't import the Python client.
const USERS = { demo: 'demo-pass', alice: 'alice-pass' }
const USERNAMES = Object.keys(USERS)

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

/** Runs once: tokens for the seeded users, and one Published file for everyone to like. */
export function setup() {
  const tokens = {}
  for (const username of USERNAMES) tokens[username] = fetchToken(username)

  const fileId = uploadFile(tokens.alice)
  waitUntilReady(tokens.alice, fileId)
  request('PATCH', `/files/${fileId}`, tokens.alice, 'publish', { visibility: 'public' })
  request('PUT', '/users/alice/follow', tokens.demo, 'follow')
  return { tokens, fileId }
}

export default function (data) {
  const username = USERNAMES[__VU % USERNAMES.length]
  const token = data.tokens[username]
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

function fetchToken(username) {
  const res = http.post(TOKEN_URL, {
    grant_type: 'password',
    client_id: 'media-cli',
    username,
    password: USERS[username],
  })
  if (res.status !== 200) throw new Error(`token for ${username}: HTTP ${res.status}`)
  return res.json('access_token')
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

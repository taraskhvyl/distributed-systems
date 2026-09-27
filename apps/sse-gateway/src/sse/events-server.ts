import http, { IncomingMessage, ServerResponse } from 'node:http'
import { AuthError, TokenVerifier } from '@mediashare/auth'
import type { Logger } from 'pino'
import { StreamRegistry } from './stream-registry.js'

const EVENTS_PATH = '/v1/events'
const HEALTH_PATH = '/healthz'
const HEARTBEAT_INTERVAL_MS = 25_000
const PREFLIGHT_CACHE_S = 600

// SSE comment lines (starting with ':') are ignored by clients.
const CONNECTED_FRAME = ': connected\n\n'
const HEARTBEAT_FRAME = ': ping\n\n'

interface EventsServerOptions {
  port: number
  webOrigin: string
  verifyAuthorizationHeader: TokenVerifier
  registry: StreamRegistry
  log: Logger
}

/**
 * Serves GET /v1/events: a Server-Sent Events stream of the caller's own file events.
 * The token is verified once at connect, and the stream is closed at the token's expiry.
 */
export function startEventsServer(options: EventsServerOptions): http.Server {
  const { port, webOrigin, verifyAuthorizationHeader, registry, log } = options
  const corsHeaders = { 'Access-Control-Allow-Origin': webOrigin }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://sse-gateway')
    if (pathname === HEALTH_PATH) {
      res.end('ok')
      return
    }
    if (pathname !== EVENTS_PATH) {
      res.writeHead(404).end()
      return
    }

    switch (req.method) {
      case 'OPTIONS':
        answerPreflight(res)
        return
      case 'GET':
        await openStream(req, res)
        return
      default:
        res.writeHead(405, corsHeaders).end()
    }
  }

  function answerPreflight(res: ServerResponse): void {
    res.writeHead(204, {
      ...corsHeaders,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Max-Age': String(PREFLIGHT_CACHE_S),
    })
    res.end()
  }

  async function openStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let user
    try {
      user = await verifyAuthorizationHeader(req.headers.authorization)
    } catch (err) {
      if (!(err instanceof AuthError)) throw err
      res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: err.code, message: err.message } }))
      return
    }

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    res.write(CONNECTED_FRAME)
    registry.add(user.id, res)

    // Keeps idle proxies from cutting the connection; a failed write reveals a dead peer.
    const heartbeat = setInterval(() => res.write(HEARTBEAT_FRAME), HEARTBEAT_INTERVAL_MS)

    // The token was checked only at connect. Without this cut-off a 5-minute token would
    // authorize the stream forever, so a disabled user would keep receiving events.
    const msUntilExpiry = Math.max(0, user.expiresAt * 1000 - Date.now())
    const closeAtExpiry = setTimeout(() => res.end(), msUntilExpiry)

    log.info({ userId: user.id, openStreams: registry.countFor(user.id), closesInMs: msUntilExpiry }, 'sse stream opened')

    res.on('close', () => {
      clearInterval(heartbeat)
      clearTimeout(closeAtExpiry)
      registry.remove(user.id, res)
      log.info({ userId: user.id }, 'sse stream closed')
    })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error({ err }, 'events request failed')
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.listen(port, '0.0.0.0')
  return server
}

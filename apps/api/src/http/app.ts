import Fastify, { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { FastifyOtelInstrumentation } from '@fastify/otel'
import { postgresPing } from '../adapters/postgres.js'
import { redisPing } from '../adapters/redis.js'
import { config } from '../config.js'
import { DomainError, DomainErrorCode } from '../errors.js'
import { fileRoutes } from '../files/routes.js'
import { socialRoutes } from '../social/routes.js'
import { userRoutes } from '../users/routes.js'
import { rememberCaller } from '../users/service.js'
import { authenticate } from './auth.js'
import { rateLimitMutations } from './rate-limit.js'

// The one place that knows how a domain failure looks in HTTP.
const STATUS_BY_ERROR_CODE: Record<DomainErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  blocked: 403,
  invalid_state: 409,
  not_uploaded: 409,
  size_mismatch: 409,
  processing_failed: 409,
}

/** Builds the HTTP app: instrumentation, health checks, errors, CORS, then /v1. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
    },
  })

  // Route-level spans (name = route, e.g. "POST /v1/files/:id/like") plus a span per hook.
  // Registered first so it wraps every route below. The http instrumentation alone only
  // yields spans named "POST". Uses the tracer provider the zero-code SDK registered.
  await app.register(new FastifyOtelInstrumentation().plugin())

  registerHealthChecks(app)
  app.setErrorHandler(handleError)

  // CORS: lets JS on the web origin call us. Browsers enforce it; curl ignores it.
  // Registered at the root, so preflights are answered before the auth hook in v1Routes
  // (a preflight never carries the token, it only asks whether sending one is allowed).
  await app.register(cors, {
    origin: config.webOrigin, // one exact origin, never '*' together with credentials
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // traceparent: the browser starts the trace (apps/web/js/trace.js). Without it here the
    // preflight "succeeds" but the browser drops the real request: "Failed to fetch".
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'traceparent'],
    exposedHeaders: ['Retry-After'], // otherwise JS can't read it on a 429
    maxAge: 600, // browser caches the preflight for 10 min instead of doubling every request
  })

  await app.register(v1Routes, { prefix: '/v1' })
  return app
}

/** Every /v1 route: authenticate → mirror the user locally → rate-limit writes → handler. */
async function v1Routes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', async (req) => rememberCaller(req.user!))
  app.addHook('preHandler', rateLimitMutations)

  await app.register(fileRoutes)
  await app.register(userRoutes)
  await app.register(socialRoutes)
}

function registerHealthChecks(app: FastifyInstance) {
  // Liveness: the process is up. Readiness: its dependencies answer, so it can take traffic.
  app.get('/healthz', async () => ({ ok: true }))

  app.get('/readyz', async (_req, reply) => {
    try {
      await postgresPing()
      await redisPing()
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })
}

/**
 * Expected failures (DomainError, schema validation) become 4xx without an error log;
 * anything else is a bug: logged with its stack, answered with an opaque 500.
 */
function handleError(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    return reply.code(STATUS_BY_ERROR_CODE[err.code]).send({ error: { code: err.code, message: err.message } })
  }
  if (err.validation) {
    return reply.code(400).send({ error: { code: 'bad_request', message: err.message } })
  }
  req.log.error({ err }, 'unhandled error')
  return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } })
}

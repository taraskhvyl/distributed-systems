import { createTokenVerifier } from '@mediashare/auth'
import { Redis } from 'ioredis'
import { config } from './config.js'
import { logger } from './log.js'
import { subscribeToLiveEvents } from './redis/subscriber.js'
import { startEventsServer } from './sse/events-server.js'
import { StreamRegistry } from './sse/stream-registry.js'

// Composition root: builds the parts and connects them. No logic of its own.
async function main() {
  const registry = new StreamRegistry()

  // enableReadyCheck: false because the ready check runs INFO, which this Redis user may
  // not (it may only SUBSCRIBE to the live-events channel). ioredis resubscribes by
  // itself after a reconnect.
  const redis = new Redis(config.redisUrl, { enableReadyCheck: false })
  await subscribeToLiveEvents(redis, registry)

  const eventsServer = startEventsServer({
    port: config.port,
    webOrigin: config.webOrigin,
    verifyAuthorizationHeader: createTokenVerifier({ issuer: config.authIssuer, jwksUrl: config.authJwksUrl }),
    registry,
    log: logger,
  })
  logger.info({ port: config.port }, 'sse gateway started')

  const shutdown = () => {
    eventsServer.closeAllConnections()
    eventsServer.close()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error')
  process.exit(1)
})

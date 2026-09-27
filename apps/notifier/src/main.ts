import { createTokenVerifier } from '@mediashare/auth'
import { Redis } from 'ioredis'
import { config } from './config.js'
import { startConsumer } from './kafka/consumer.js'
import { logger } from './log.js'
import { sendNotification } from './notifications/webhook.js'
import { createFanoutPublisher, subscribeFanout } from './redis/fanout.js'
import { startEventsServer } from './sse/events-server.js'
import { pushToOwnerStreams } from './sse/push.js'
import { StreamRegistry } from './sse/stream-registry.js'

// Composition root: builds the parts and connects them. No logic of its own.
async function main() {
  const registry = new StreamRegistry()

  // Two connections: one in subscriber mode can't publish. The publisher fails fast
  // (no offline queue) while Redis is down, so a Kafka handler never hangs on it.
  const redisPublisher = new Redis(config.redisUrl, { enableOfflineQueue: false })
  const redisSubscriber = new Redis(config.redisUrl)
  await subscribeFanout(redisSubscriber, registry)

  const eventsServer = startEventsServer({
    port: config.port,
    webOrigin: config.webOrigin,
    verifyAuthorizationHeader: createTokenVerifier({ issuer: config.authIssuer, jwksUrl: config.authJwksUrl }),
    registry,
    log: logger,
  })

  const consumer = await startConsumer([pushToOwnerStreams(createFanoutPublisher(redisPublisher)), sendNotification])
  logger.info({ port: config.port, webhook: Boolean(config.webhookUrl) }, 'notifier started')

  const shutdown = async () => {
    eventsServer.closeAllConnections()
    eventsServer.close()
    await consumer.disconnect().catch(() => {})
    redisPublisher.disconnect()
    redisSubscriber.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error')
  process.exit(1)
})

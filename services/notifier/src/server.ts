import { createTokenVerifier } from '@mediashare/auth'
import { config } from './config.js'
import { EnvelopeHandler, startConsumer } from './consumer.js'
import { startEventsServer } from './events-server.js'
import { logger } from './log.js'
import { describeEvent, sendNotification } from './notifications.js'
import { StreamRegistry } from './stream-registry.js'

// Composition root: builds the parts and connects them. No logic of its own.
async function main() {
  const registry = new StreamRegistry()

  const eventsServer = startEventsServer({
    port: config.port,
    webOrigin: config.webOrigin,
    verifyAuthorizationHeader: createTokenVerifier({ issuer: config.authIssuer, jwksUrl: config.authJwksUrl }),
    registry,
    log: logger,
  })

  const pushToOwnerStreams: EnvelopeHandler = async (envelope) => {
    const ownerId = envelope.payload.ownerId
    if (!ownerId) return
    registry.publish(ownerId, envelope.eventType, {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      fileId: envelope.payload.fileId,
      message: describeEvent(envelope),
    })
  }

  const consumer = await startConsumer([pushToOwnerStreams, sendNotification])
  logger.info({ port: config.port, webhook: Boolean(config.webhookUrl) }, 'notifier started')

  const shutdown = async () => {
    eventsServer.closeAllConnections()
    eventsServer.close()
    await consumer.disconnect().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error')
  process.exit(1)
})

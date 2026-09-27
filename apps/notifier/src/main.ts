import { Redis } from 'ioredis'
import { config } from './config.js'
import { startConsumer } from './kafka/consumer.js'
import { logger } from './log.js'
import { pushToOwnerStreams } from './notifications/live-push.js'
import { sendNotification } from './notifications/webhook.js'
import { createLiveEventPublisher } from './redis/publisher.js'

// Composition root: builds the parts and connects them. No logic of its own.
async function main() {
  // enableOfflineQueue: false fails fast while Redis is down, so a Kafka handler never
  // hangs on it. enableReadyCheck: false because the ready check runs INFO, which this
  // Redis user may not (it may only PUBLISH on the Live events channel).
  const redis = new Redis(config.redisUrl, { enableOfflineQueue: false, enableReadyCheck: false })

  const consumer = await startConsumer([pushToOwnerStreams(createLiveEventPublisher(redis)), sendNotification])
  logger.info({ webhook: Boolean(config.webhookUrl) }, 'notifier started')

  const shutdown = async () => {
    await consumer.disconnect().catch(() => {})
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

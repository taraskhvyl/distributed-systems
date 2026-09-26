import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
})

export const config = {
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','),
  topicMain: process.env.TOPIC_MAIN ?? 'file-events',
  groupId: 'notifier',
  webhookUrl: process.env.WEBHOOK_URL || null,
}

const NOTIFICATION_TEMPLATES: Record<string, (payload: Record<string, unknown>) => string> = {
  'file.ready': (p) => `Your file "${p.filename ?? p.fileId}" is ready (thumbnail: ${p.thumbnailKey ? 'yes' : 'no'})`,
  'file.rejected': (p) => `Your upload "${p.filename ?? p.fileId}" was rejected: ${p.reason}`,
  'file.failed': (p) => `Your upload "${p.fileId}" could not be processed: ${p.error}`,
}

async function deliverWebhook(body: unknown): Promise<void> {
  if (!config.webhookUrl) return
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) logger.warn({ status: res.status }, 'webhook endpoint returned error status')
  } catch (err) {
    logger.warn({ err }, 'webhook delivery failed (would be retried with backoff in production)')
  }
}

async function main() {
  const { Kafka } = await import('kafkajs')
  const kafka = new Kafka({
    clientId: 'mediashare-notifier',
    brokers: config.kafkaBrokers,
    retry: { retries: 10 },
  })
  const consumer = kafka.consumer({ groupId: config.groupId })

  await consumer.connect()
  await consumer.subscribe({ topic: config.topicMain, fromBeginning: false })
  logger.info(
    { groupId: config.groupId, topic: config.topicMain, webhook: Boolean(config.webhookUrl) },
    'notifier started',
  )

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let envelope: any
      try {
        envelope = JSON.parse(message.value?.toString() ?? '')
      } catch {
        logger.warn({ topic, partition, offset: message.offset }, 'skipped malformed message')
        return
      }
      const render = NOTIFICATION_TEMPLATES[envelope.eventType]
      if (!render) return
      const notification = {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        userId: envelope.payload?.ownerId,
        fileId: envelope.payload?.fileId,
        message: render(envelope.payload ?? {}),
        deliveredAt: new Date().toISOString(),
      }
      logger.info(notification, 'user notification dispatched')
      await deliverWebhook(notification)
    },
  })

  const shutdown = async () => {
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

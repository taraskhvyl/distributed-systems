import { Consumer, Kafka } from 'kafkajs'
import { config } from '../config.js'
import { EnvelopeHandler, EventEnvelope } from '../events.js'
import { logger } from '../log.js'

/**
 * Consumes `file-events` in the notifier's own consumer group and passes every event to
 * each handler in order. Delivery is at-least-once, so handlers must tolerate duplicates.
 */
export async function startConsumer(handlers: EnvelopeHandler[]): Promise<Consumer> {
  const kafka = new Kafka({
    clientId: 'mediashare-notifier',
    brokers: config.kafkaBrokers,
    retry: { retries: 10 },
  })
  const consumer = kafka.consumer({ groupId: config.groupId })

  await consumer.connect()
  await consumer.subscribe({ topic: config.topicMain, fromBeginning: false })
  logger.info({ groupId: config.groupId, topic: config.topicMain }, 'consumer started')

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const envelope = parseEnvelope(message.value)
      if (!envelope) {
        logger.warn({ topic, partition, offset: message.offset }, 'skipped malformed message')
        return
      }
      for (const handle of handlers) await handle(envelope)
    },
  })
  return consumer
}

function parseEnvelope(value: Buffer | null): EventEnvelope | null {
  try {
    const envelope = JSON.parse(value?.toString() ?? '')
    const isEnvelope = typeof envelope?.eventType === 'string' && typeof envelope?.payload === 'object'
    return isEnvelope ? envelope : null
  } catch {
    return null
  }
}

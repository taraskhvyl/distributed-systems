import { config } from '../config.js'
import type { EventEnvelope } from '../events.js'
import { logger } from '../log.js'
import { describeEvent } from './messages.js'

const WEBHOOK_TIMEOUT_MS = 3000

/** Handler: log the notification and POST it to the optional webhook. */
export async function sendNotification(envelope: EventEnvelope): Promise<void> {
  const message = describeEvent(envelope)
  if (!message) return

  const notification = {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    userId: envelope.payload.ownerId,
    fileId: envelope.payload.fileId,
    message,
    deliveredAt: new Date().toISOString(),
  }
  logger.info(notification, 'user notification dispatched')
  await deliverWebhook(notification)
}

async function deliverWebhook(body: unknown): Promise<void> {
  if (!config.webhookUrl) return
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    if (!res.ok) logger.warn({ status: res.status }, 'webhook endpoint returned error status')
  } catch (err) {
    logger.warn({ err }, 'webhook delivery failed (would be retried with backoff in production)')
  }
}

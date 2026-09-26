import { config } from './config.js'
import type { EventEnvelope } from './consumer.js'
import { logger } from './log.js'

const WEBHOOK_TIMEOUT_MS = 3000

type MessageRenderer = (payload: EventEnvelope['payload']) => string

// Strategy: one message renderer per event type. Event types without a renderer
// (e.g. file.uploaded) are internal steps and produce no user notification.
const MESSAGE_RENDERERS: Record<string, MessageRenderer> = {
  'file.ready': (p) => `Your file "${p.filename ?? p.fileId}" is ready (thumbnail: ${p.thumbnailKey ? 'yes' : 'no'})`,
  'file.rejected': (p) => `Your upload "${p.filename ?? p.fileId}" was rejected: ${p.reason}`,
  'file.failed': (p) => `Your upload "${p.fileId}" could not be processed: ${p.error}`,
}

/** Human-readable text for an event, or undefined if users aren't notified about it. */
export function describeEvent(envelope: EventEnvelope): string | undefined {
  return MESSAGE_RENDERERS[envelope.eventType]?.(envelope.payload)
}

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

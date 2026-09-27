import { LIVE_EVENTS_CHANNEL, decodeLiveEvent } from '@mediashare/live-events'
import { context } from '@opentelemetry/api'
import { Redis } from 'ioredis'
import { logger } from '../log.js'
import type { StreamRegistry } from '../sse/stream-registry.js'

/**
 * Adapter: receives Live events from the notifier over Redis pub/sub and delivers each
 * one to the streams this replica holds. Every replica subscribes, because the user's
 * tabs may be open on any of them (Envoy balances connections).
 *
 * Scaling limit: one channel for all users, so every replica receives every event
 * (replicas × event rate). Fix when that matters: a channel per user, SUBSCRIBE when a
 * user's first stream opens here and UNSUBSCRIBE when the last one closes.
 */
export async function subscribeToLiveEvents(subscriber: Redis, registry: StreamRegistry): Promise<void> {
  subscriber.on('message', (_channel: string, raw: string) => deliverLocally(raw, registry))
  await subscriber.subscribe(LIVE_EVENTS_CHANNEL)
}

function deliverLocally(raw: string, registry: StreamRegistry): void {
  const decoded = decodeLiveEvent(raw)
  if (!decoded) {
    logger.warn('skipped malformed live event')
    return
  }
  const { event, publisherContext } = decoded
  // Only replicas holding this user's streams act, so `sse.publish` spans appear only
  // where a browser actually received the event.
  const holdsUserStreams = registry.countFor(event.userId) > 0
  if (!holdsUserStreams) return

  context.with(publisherContext, () => registry.publish(event.userId, event.eventName, event.data))
}

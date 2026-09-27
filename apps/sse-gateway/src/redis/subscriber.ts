import { context, propagation } from '@opentelemetry/api'
import { Redis } from 'ioredis'
import { logger } from '../log.js'
import type { StreamRegistry } from '../sse/stream-registry.js'

/**
 * Adapter: receives live events from the notifier over Redis pub/sub and delivers each
 * one to the streams this replica holds. Every replica subscribes, because the user's
 * tabs may be open on any of them (Envoy balances connections).
 *
 * Scaling limit: one channel for all users, so every replica receives every event
 * (replicas × event rate). Fix when that matters: a channel per user, SUBSCRIBE when a
 * user's first stream opens here and UNSUBSCRIBE when the last one closes.
 *
 * The wire contract (channel + message shape) is duplicated on purpose in
 * apps/notifier/src/redis/publisher.ts: a shared package would couple the deploys of the
 * two services for two small types. Change both.
 */
const CHANNEL = 'sse-events'

interface WireMessage {
  userId: string
  eventName: string
  data: Record<string, unknown>
  traceContext: Record<string, string>
}

export async function subscribeToLiveEvents(subscriber: Redis, registry: StreamRegistry): Promise<void> {
  subscriber.on('message', (_channel: string, raw: string) => deliverLocally(raw, registry))
  await subscriber.subscribe(CHANNEL)
}

function deliverLocally(raw: string, registry: StreamRegistry): void {
  let wire: WireMessage
  try {
    wire = JSON.parse(raw)
  } catch {
    logger.warn('skipped malformed live event')
    return
  }
  // Only replicas holding this user's streams act, so `sse.publish` spans appear only
  // where a browser actually received the event.
  const holdsUserStreams = registry.countFor(wire.userId) > 0
  if (!holdsUserStreams) return

  const publisherContext = propagation.extract(context.active(), wire.traceContext)
  context.with(publisherContext, () => registry.publish(wire.userId, wire.eventName, wire.data))
}

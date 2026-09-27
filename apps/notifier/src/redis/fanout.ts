import { context, propagation } from '@opentelemetry/api'
import { Redis } from 'ioredis'
import { logger } from '../log.js'
import type { StreamRegistry } from '../sse/stream-registry.js'

/**
 * Fan-out across notifier replicas over Redis pub/sub.
 *
 * Why: Kafka hands an event to the replica that owns its partition, but the user's SSE
 * streams can be open on any replica (Envoy balances connections). So the consuming
 * replica publishes here, and every replica delivers to the streams it holds.
 *
 * Pub/sub is fire-and-forget: a replica that is disconnected from Redis misses the
 * message. That matches SSE's existing at-most-once (the client resyncs on reconnect).
 *
 * Scaling limit: one channel for all users, so every replica receives every event
 * (replicas × event rate). Fix when that matters: a channel per user, SUBSCRIBE when a
 * user's first stream opens on this replica and UNSUBSCRIBE when the last one closes.
 */
const CHANNEL = 'sse-events'

export interface SseMessage {
  userId: string
  eventName: string
  data: Record<string, unknown>
}

/** What goes over the wire: the message plus the trace it was published in. */
interface WireMessage extends SseMessage {
  traceContext: Record<string, string>
}

export type PublishSse = (message: SseMessage) => Promise<void>

/** Publisher side, used on the replica that consumed the Kafka event. */
export function createFanoutPublisher(redis: Redis): PublishSse {
  return async (message) => {
    // Redis pub/sub carries no headers, and auto-instrumentation stops at this hop:
    // the trace context travels inside the payload, like the outbox's traceparent column.
    const traceContext: Record<string, string> = {}
    propagation.inject(context.active(), traceContext)
    const wire: WireMessage = { ...message, traceContext }
    try {
      await redis.publish(CHANNEL, JSON.stringify(wire))
    } catch (err) {
      // Drop, don't throw: a throw would make Kafka redeliver forever and stall the
      // other handlers (webhook notifications) for as long as Redis is down.
      logger.warn({ err, userId: message.userId }, 'sse fan-out publish failed, event dropped')
    }
  }
}

/**
 * Subscriber side, on every replica. A subscribed ioredis connection can't run other
 * commands, so it must be a separate connection from the publisher's.
 */
export async function subscribeFanout(subscriber: Redis, registry: StreamRegistry): Promise<void> {
  subscriber.on('message', (_channel: string, raw: string) => deliverLocally(raw, registry))
  await subscriber.subscribe(CHANNEL)
}

function deliverLocally(raw: string, registry: StreamRegistry): void {
  let wire: WireMessage
  try {
    wire = JSON.parse(raw)
  } catch {
    logger.warn('skipped malformed fan-out message')
    return
  }
  // Every replica gets every message; only the ones holding this user's streams act,
  // so `sse.publish` spans appear only where a browser actually received the event.
  const holdsUserStreams = registry.countFor(wire.userId) > 0
  if (!holdsUserStreams) return

  const producerContext = propagation.extract(context.active(), wire.traceContext)
  context.with(producerContext, () => registry.publish(wire.userId, wire.eventName, wire.data))
}

import { context, propagation } from '@opentelemetry/api'
import { Redis } from 'ioredis'
import { logger } from '../log.js'

/**
 * Adapter: hands live events to the SSE gateway over Redis pub/sub.
 *
 * The notifier consumes Kafka on the `data` network; the browser's streams are held by
 * `sse-gateway` on the edge, which can't reach Kafka at all (docs/SECURITY.md). This
 * channel is the only link between them, and each side's Redis user may only
 * PUBLISH / SUBSCRIBE on it (Redis ACL in compose/data.yml).
 *
 * Pub/sub is fire-and-forget: a gateway replica disconnected from Redis misses the
 * message. That matches SSE's at-most-once (the client resyncs on reconnect).
 *
 * The wire contract (channel + message shape) is duplicated on purpose in
 * apps/sse-gateway/src/redis/subscriber.ts: a shared package would couple the deploys of
 * the two services for two small types. Change both.
 */
const CHANNEL = 'sse-events'

export interface SseMessage {
  userId: string
  eventName: string
  data: Record<string, unknown>
}

/** On the wire: the message plus the trace it was published in. */
interface WireMessage extends SseMessage {
  traceContext: Record<string, string>
}

export type PublishSse = (message: SseMessage) => Promise<void>

export function createSsePublisher(redis: Redis): PublishSse {
  return async (message) => {
    // Pub/sub carries no headers and auto-instrumentation stops at this hop, so the trace
    // context travels inside the payload, like the outbox's traceparent column.
    const traceContext: Record<string, string> = {}
    propagation.inject(context.active(), traceContext)
    const wire: WireMessage = { ...message, traceContext }
    try {
      await redis.publish(CHANNEL, JSON.stringify(wire))
    } catch (err) {
      // Drop, don't throw: a throw would make Kafka redeliver forever and stall the
      // other handlers (webhook notifications) for as long as Redis is down.
      logger.warn({ err, userId: message.userId }, 'live event publish failed, event dropped')
    }
  }
}

import { LIVE_EVENTS_CHANNEL, type LiveEvent, encodeLiveEvent } from '@mediashare/live-events'
import { Redis } from 'ioredis'
import { logger } from '../log.js'

/**
 * Adapter: hands Live events to sse-gateway over Redis pub/sub.
 *
 * The notifier consumes Kafka on the `data` network; the browser's streams are held by
 * sse-gateway on the edge, which can't reach Kafka at all (ADR 0005). This channel is the
 * only link between them, and this service's Redis user may only PUBLISH on it.
 *
 * Pub/sub is fire-and-forget: a gateway replica disconnected from Redis misses the
 * message. That matches SSE's at-most-once (the client resyncs on reconnect).
 */
export type PublishLiveEvent = (event: LiveEvent) => Promise<void>

export function createLiveEventPublisher(redis: Redis): PublishLiveEvent {
  return async (event) => {
    try {
      await redis.publish(LIVE_EVENTS_CHANNEL, encodeLiveEvent(event))
    } catch (err) {
      // Drop, don't throw: a throw would make Kafka redeliver forever and stall the
      // other handlers (webhook notifications) for as long as Redis is down.
      logger.warn({ err, userId: event.userId }, 'live event publish failed, event dropped')
    }
  }
}

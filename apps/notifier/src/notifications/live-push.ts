import type { EnvelopeHandler } from '../events.js'
import type { PublishLiveEvent } from '../redis/publisher.js'
import { describeEvent } from './messages.js'

/**
 * Handler: send the event to the file owner's open browser tabs (via the SSE gateway).
 * At-most-once: if the owner has no tab connected right now, the event is gone (the
 * client resyncs on reconnect).
 */
export function pushToOwnerStreams(publish: PublishLiveEvent): EnvelopeHandler {
  return async (envelope) => {
    const ownerId = envelope.payload.ownerId
    if (!ownerId) return
    await publish({
      userId: ownerId,
      eventName: envelope.eventType,
      data: {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        fileId: envelope.payload.fileId,
        message: describeEvent(envelope),
      },
    })
  }
}

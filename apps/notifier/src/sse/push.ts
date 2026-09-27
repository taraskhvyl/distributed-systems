import type { EnvelopeHandler } from '../events.js'
import { describeEvent } from '../notifications/messages.js'
import type { PublishSse } from '../redis/fanout.js'

/**
 * Handler: push an event to every open stream of the file's owner, on whichever replica
 * holds them (`publish` fans out over Redis). At-most-once: if the owner has no tab
 * connected right now, the event is gone (the client resyncs on reconnect).
 */
export function pushToOwnerStreams(publish: PublishSse): EnvelopeHandler {
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

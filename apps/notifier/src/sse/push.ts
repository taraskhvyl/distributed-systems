import type { EnvelopeHandler } from '../events.js'
import { describeEvent } from '../notifications/messages.js'
import { StreamRegistry } from './stream-registry.js'

/**
 * Handler: push an event to every open stream of the file's owner. At-most-once: if the
 * owner has no tab connected right now, the event is gone (the client resyncs on reconnect).
 */
export function pushToOwnerStreams(registry: StreamRegistry): EnvelopeHandler {
  return async (envelope) => {
    const ownerId = envelope.payload.ownerId
    if (!ownerId) return
    registry.publish(ownerId, envelope.eventType, {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      fileId: envelope.payload.fileId,
      message: describeEvent(envelope),
    })
  }
}

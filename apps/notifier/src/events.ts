/**
 * The message format every producer writes to `file-events` (the api's outbox relay, the
 * processor). The contract between services: Kafka, SSE and notifications all read it.
 */
export interface EventEnvelope {
  eventId: string
  eventType: string
  aggregateId: string
  occurredAt: string
  payload: {
    ownerId?: string
    fileId?: string
    [field: string]: unknown
  }
}

/** Strategy: one handler per thing to do with an event (push to SSE, notify, ...). */
export type EnvelopeHandler = (envelope: EventEnvelope) => Promise<void>

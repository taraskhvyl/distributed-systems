import { type Context, context, propagation } from '@opentelemetry/api'

/**
 * The contract between the notifier (PUBLISH) and sse-gateway (SUBSCRIBE): one Redis
 * pub/sub channel and the message format on it. One definition, so a change that breaks
 * one side fails the build of the other instead of silently dropping events.
 *
 * The compiler only sees one commit: during a rolling deploy an old subscriber meets a
 * new publisher, so a field may be added, never renamed or removed in one step.
 */

/** Also named in the Redis ACL (`&sse-events` in compose/data.yml): change both. */
export const LIVE_EVENTS_CHANNEL = 'sse-events'

/** A Live event (CONTEXT.md): what gets written to one user's open tabs. */
export interface LiveEvent {
  userId: string
  eventName: string
  data: Record<string, unknown>
}

/** On the wire: the event plus the trace it was published in. */
interface WireMessage extends LiveEvent {
  traceContext: Record<string, string>
}

/**
 * Serializes an event with the active trace context. Pub/sub carries no headers and
 * auto-instrumentation stops at this hop, so the context rides inside the payload (like
 * the outbox's traceparent column).
 */
export function encodeLiveEvent(event: LiveEvent): string {
  const traceContext: Record<string, string> = {}
  propagation.inject(context.active(), traceContext)
  const wire: WireMessage = { ...event, traceContext }
  return JSON.stringify(wire)
}

export interface DecodedLiveEvent {
  event: LiveEvent
  /** The publisher's trace: run the delivery inside it to continue that trace. */
  publisherContext: Context
}

/** Parses one pub/sub message; null if it isn't a Live event. */
export function decodeLiveEvent(raw: string): DecodedLiveEvent | null {
  let wire: WireMessage
  try {
    wire = JSON.parse(raw)
  } catch {
    return null
  }
  const isLiveEvent = typeof wire?.userId === 'string' && typeof wire?.eventName === 'string'
  if (!isLiveEvent) return null

  const { traceContext, ...event } = wire
  return { event, publisherContext: propagation.extract(context.active(), traceContext ?? {}) }
}

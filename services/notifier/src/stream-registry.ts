import type { ServerResponse } from 'node:http'
import { trace } from '@opentelemetry/api'

const tracer = trace.getTracer('mediashare-notifier/sse')

/**
 * Registry pattern: the open SSE streams of each user, so an event can be routed to every
 * tab of the user it belongs to.
 *
 * Scaling limit: the registry lives in this process's memory. With more than one notifier
 * replica, Kafka may hand an event to a replica that doesn't hold the user's stream.
 * Fix (roadmap Phase 3): every replica publishes to Redis pub/sub and each one delivers
 * to the streams it holds.
 */
export class StreamRegistry {
  private readonly streamsByUser = new Map<string, Set<ServerResponse>>()

  add(userId: string, stream: ServerResponse): void {
    const streams = this.streamsByUser.get(userId) ?? new Set()
    streams.add(stream)
    this.streamsByUser.set(userId, streams)
  }

  remove(userId: string, stream: ServerResponse): void {
    const streams = this.streamsByUser.get(userId)
    if (!streams) return
    streams.delete(stream)
    if (streams.size === 0) this.streamsByUser.delete(userId)
  }

  countFor(userId: string): number {
    return this.streamsByUser.get(userId)?.size ?? 0
  }

  /**
   * Writes the event to every open stream of the user, inside an `sse.publish` span.
   * The stream was opened long before, so no request carries this trace to the browser:
   * the span (child of the Kafka consume) records the write, and `traceId` in the frame
   * lets the browser console name the trace it received. openStreams = 0 means the event
   * was dropped because the user had no tab connected.
   */
  publish(userId: string, eventName: string, data: Record<string, unknown>): void {
    tracer.startActiveSpan('sse.publish', (span) => {
      const streams = this.streamsByUser.get(userId) ?? new Set<ServerResponse>()
      span.setAttributes({ 'sse.user_id': userId, 'sse.event': eventName, 'sse.open_streams': streams.size })
      const frame = formatSseEvent(eventName, { ...data, traceId: span.spanContext().traceId })
      for (const stream of streams) stream.write(frame)
      span.end()
    })
  }
}

/** One SSE frame: `event:` + `data:` lines, terminated by a blank line. */
function formatSseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

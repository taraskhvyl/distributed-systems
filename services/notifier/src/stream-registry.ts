import type { ServerResponse } from 'node:http'

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

  publish(userId: string, eventName: string, data: unknown): void {
    const streams = this.streamsByUser.get(userId)
    if (!streams) return
    const frame = formatSseEvent(eventName, data)
    for (const stream of streams) stream.write(frame)
  }
}

/** One SSE frame: `event:` + `data:` lines, terminated by a blank line. */
function formatSseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

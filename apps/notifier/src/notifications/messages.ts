import type { EventEnvelope } from '../events.js'

type MessageRenderer = (payload: EventEnvelope['payload']) => string

// Strategy: one message renderer per event type. Event types without a renderer
// (e.g. file.uploaded) are internal steps and produce no user notification.
const MESSAGE_RENDERERS: Record<string, MessageRenderer> = {
  'file.ready': (p) => `Your file "${p.filename ?? p.fileId}" is ready (thumbnail: ${p.thumbnailKey ? 'yes' : 'no'})`,
  'file.rejected': (p) => `Your upload "${p.filename ?? p.fileId}" was rejected: ${p.reason}`,
  'file.failed': (p) => `Your upload "${p.fileId}" could not be processed: ${p.error}`,
  'file.liked': (p) => `@${p.likerUsername} liked your file "${p.filename ?? p.fileId}"`,
}

/** Human-readable text for an event, or undefined if users aren't notified about it. */
export function describeEvent(envelope: EventEnvelope): string | undefined {
  return MESSAGE_RENDERERS[envelope.eventType]?.(envelope.payload)
}

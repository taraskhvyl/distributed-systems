// Keyset-pagination cursor for the feed: "the last item I saw". Opaque to clients
// (base64url JSON) so its shape can change without an API break.

// Cursors come back from clients, so they are untrusted input: check the shape before SQL.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PG_TIMESTAMPTZ_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/

export interface FeedPosition {
  /** Postgres text form of created_at, microsecond precision (see FileView.created_at_exact). */
  createdAt: string
  id: string
}

export function encodeFeedCursor(position: FeedPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

/** null if the cursor is malformed or tampered with. */
export function decodeFeedCursor(cursor: string): FeedPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const isValid = PG_TIMESTAMPTZ_PATTERN.test(parsed?.createdAt) && UUID_PATTERN.test(parsed?.id)
    return isValid ? { createdAt: parsed.createdAt, id: parsed.id } : null
  } catch {
    return null
  }
}

import { FastifyInstance } from 'fastify'
import { PoolClient } from 'pg'
import { pool, withTransaction } from './db.js'
import {
  FILE_VIEW_SELECT,
  FileView,
  IS_PUBLISHED_SQL,
  findPublishedFileForUpdate,
  serializePublicFile,
} from './file-access.js'
import { FILE_ID_PARAMS } from './file-routes.js'
import { insertOutboxEvent } from './outbox.js'
import { findUserByUsername, getProfile, searchUsers } from './users.js'

const FEED_DEFAULT_LIMIT = 20
const FEED_MAX_LIMIT = 50
// Cursors come back from clients, so they are untrusted input: check the shape before SQL.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PG_TIMESTAMPTZ_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/

const USERNAME_PARAMS = {
  type: 'object',
  required: ['username'],
  properties: { username: { type: 'string', minLength: 1, maxLength: 255 } },
} as const

const USER_NOT_FOUND = { error: { code: 'not_found', message: 'User not found' } }
const FILE_NOT_FOUND = { error: { code: 'not_found', message: 'File not found' } }

export async function socialRoutes(app: FastifyInstance) {
  app.get(
    '/users',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1, maxLength: 255 } },
        },
      },
    },
    async (req) => {
      const { q } = req.query as { q: string }
      return { users: await searchUsers(req.user!.id, q.toLowerCase()) }
    },
  )

  app.get('/users/:username', { schema: { params: USERNAME_PARAMS } }, async (req, reply) => {
    const { username } = req.params as { username: string }
    const user = await findUserByUsername(username)
    if (!user) return reply.code(404).send(USER_NOT_FOUND)
    return { user: await getProfile(req.user!.id, user) }
  })

  // Follow is a state, so PUT/DELETE are idempotent by nature: repeating them changes nothing.
  app.put('/users/:username/follow', { schema: { params: USERNAME_PARAMS } }, async (req, reply) => {
    const { username } = req.params as { username: string }
    const followee = await findUserByUsername(username)
    if (!followee) return reply.code(404).send(USER_NOT_FOUND)
    // The follows_not_self CHECK constraint is the real guarantee; this gives a clear 400.
    if (followee.id === req.user!.id) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'You cannot follow yourself' } })
    }
    await pool.query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user!.id, followee.id],
    )
    return { following: true }
  })

  app.delete('/users/:username/follow', { schema: { params: USERNAME_PARAMS } }, async (req, reply) => {
    const { username } = req.params as { username: string }
    const followee = await findUserByUsername(username)
    if (!followee) return reply.code(404).send(USER_NOT_FOUND)
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user!.id, followee.id])
    return { following: false }
  })

  app.put('/files/:id/like', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await withTransaction((client) => likeFile(client, id, req.user!))
    if (!result) return reply.code(404).send(FILE_NOT_FOUND)
    return { liked: true, likeCount: result.likeCount }
  })

  app.delete('/files/:id/like', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await withTransaction((client) => unlikeFile(client, id, req.user!.id))
    if (!result) return reply.code(404).send(FILE_NOT_FOUND)
    return { liked: false, likeCount: result.likeCount }
  })

  app.get(
    '/feed',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: FEED_MAX_LIMIT, default: FEED_DEFAULT_LIMIT },
          },
        },
      },
    },
    async (req, reply) => {
      const { cursor, limit } = req.query as { cursor?: string; limit: number }
      const position = cursor ? decodeFeedCursor(cursor) : null
      if (cursor && !position) {
        return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid cursor' } })
      }
      const files = await readFeed(req.user!.id, position, limit)
      const last = files.at(-1)
      const hasMore = files.length === limit && last !== undefined
      return {
        files: files.map(serializePublicFile),
        nextCursor: hasMore ? encodeFeedCursor({ createdAt: last.created_at_exact, id: last.id }) : null,
      }
    },
  )
}

/**
 * One like, in one transaction. The likes PK makes it idempotent: a repeated like inserts
 * nothing, so like_count and the outbox event change only when a row was really inserted.
 * `like_count + 1` is computed by Postgres under the row lock, so concurrent likes don't
 * lose updates the way a read-in-Node-then-write would.
 */
async function likeFile(
  client: PoolClient,
  fileId: string,
  liker: { id: string; username: string },
): Promise<{ likeCount: number } | null> {
  const file = await findPublishedFileForUpdate(client, fileId)
  if (!file) return null

  const inserted = await client.query(
    'INSERT INTO likes (user_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1',
    [liker.id, fileId],
  )
  const isNewLike = inserted.rowCount === 1
  if (!isNewLike) return { likeCount: file.like_count }

  const { rows } = await client.query<{ like_count: number }>(
    'UPDATE files SET like_count = like_count + 1 WHERE id = $1 RETURNING like_count',
    [fileId],
  )
  // ownerId is the FILE OWNER: the notifier routes the SSE event to that user.
  await insertOutboxEvent(client, 'file.liked', fileId, {
    fileId,
    ownerId: file.owner_id,
    filename: file.filename,
    likerId: liker.id,
    likerUsername: liker.username,
  })
  return { likeCount: rows[0].like_count }
}

/** Mirror of likeFile. No event: nobody wants to be told about an unlike. */
async function unlikeFile(client: PoolClient, fileId: string, userId: string): Promise<{ likeCount: number } | null> {
  const file = await findPublishedFileForUpdate(client, fileId)
  if (!file) return null

  const deleted = await client.query('DELETE FROM likes WHERE user_id = $1 AND file_id = $2', [userId, fileId])
  const wasLiked = deleted.rowCount === 1
  if (!wasLiked) return { likeCount: file.like_count }

  const { rows } = await client.query<{ like_count: number }>(
    'UPDATE files SET like_count = like_count - 1 WHERE id = $1 RETURNING like_count',
    [fileId],
  )
  return { likeCount: rows[0].like_count }
}

interface FeedPosition {
  /** Postgres text form of created_at, microsecond precision (see FileView.created_at_exact). */
  createdAt: string
  id: string
}

/**
 * Fan-out on read: the feed is computed at request time from follows + Published files.
 * Keyset pagination: "rows strictly older than the last one I saw", which stays correct
 * when new files arrive (OFFSET would shift and repeat items) and stays fast on deep pages.
 */
async function readFeed(viewerId: string, position: FeedPosition | null, limit: number): Promise<FileView[]> {
  const { rows } = await pool.query<FileView>(
    `${FILE_VIEW_SELECT}
     JOIN follows fo ON fo.followee_id = f.owner_id AND fo.follower_id = $1
     WHERE ${IS_PUBLISHED_SQL}
       AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::uuid))
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $4`,
    [viewerId, position?.createdAt ?? null, position?.id ?? null, limit],
  )
  return rows
}

// The cursor is opaque to clients (base64url JSON) so its shape can change without an API break.
function encodeFeedCursor(position: FeedPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

function decodeFeedCursor(cursor: string): FeedPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const isValid = PG_TIMESTAMPTZ_PATTERN.test(parsed?.createdAt) && UUID_PATTERN.test(parsed?.id)
    return isValid ? { createdAt: parsed.createdAt, id: parsed.id } : null
  } catch {
    return null
  }
}

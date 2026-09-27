import { pool, withTransaction } from '../adapters/postgres.js'
import { FILE_VIEW_SELECT, FileView, IS_PUBLISHED_SQL, findPublishedFileForUpdate } from '../files/repository.js'
import { insertOutboxEvent } from '../messaging/outbox.js'
import { FeedPosition } from './feed-cursor.js'

// Repository for `follows` and `likes`, and the feed query that joins them with files.

export interface Liker {
  id: string
  username: string
}

/** Follow is a state, so repeating it changes nothing (ON CONFLICT DO NOTHING). */
export async function insertFollow(followerId: string, followeeId: string): Promise<void> {
  await pool.query(
    'INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [followerId, followeeId],
  )
}

export async function deleteFollow(followerId: string, followeeId: string): Promise<void> {
  await pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, followeeId])
}

/**
 * One like, in one transaction. The likes PK makes it idempotent: a repeated like inserts
 * nothing, so like_count and the outbox event change only when a row was really inserted.
 * `like_count + 1` is computed by Postgres under the row lock, so concurrent likes don't
 * lose updates the way a read-in-Node-then-write would.
 * Returns null if the file isn't Published (or doesn't exist).
 */
export async function insertLike(fileId: string, liker: Liker): Promise<{ likeCount: number } | null> {
  return withTransaction(async (client) => {
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
  })
}

/** Mirror of insertLike. No event: nobody wants to be told about an unlike. */
export async function deleteLike(fileId: string, userId: string): Promise<{ likeCount: number } | null> {
  return withTransaction(async (client) => {
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
  })
}

/**
 * Fan-out on read: the feed is computed at request time from follows + Published files.
 * Keyset pagination: "rows strictly older than the last one I saw", which stays correct
 * when new files arrive (OFFSET would shift and repeat items) and stays fast on deep pages.
 */
export async function readFeed(viewerId: string, after: FeedPosition | null, limit: number): Promise<FileView[]> {
  const { rows } = await pool.query<FileView>(
    `${FILE_VIEW_SELECT}
     JOIN follows fo ON fo.followee_id = f.owner_id AND fo.follower_id = $1
     WHERE ${IS_PUBLISHED_SQL}
       AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::uuid))
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $4`,
    [viewerId, after?.createdAt ?? null, after?.id ?? null, limit],
  )
  return rows
}

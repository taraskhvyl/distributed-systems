import { PoolClient } from 'pg'
import { isAdmin } from './auth.js'
import { pool } from './db.js'
import * as s3 from './s3.js'

/** A row of the `files` table. */
export interface FileRow {
  id: string
  owner_id: string
  filename: string
  content_type: string
  size_bytes: string
  status: string
  visibility: 'private' | 'public'
  like_count: number
  object_key: string
  thumbnail_key: string | null
  checksum: string | null
  created_at: Date
  updated_at: Date
}

/** A file as one viewer sees it: the row plus its owner's name and the viewer's like. */
export interface FileView extends FileRow {
  owner_username: string
  liked_by_me: boolean
  /** created_at at full microsecond precision; a JS Date would truncate it (feed cursor). */
  created_at_exact: string
}

export interface Viewer {
  id: string
  isAdmin: boolean
}

export function viewerOf(user: { id: string; roles: string[] }): Viewer {
  return { id: user.id, isAdmin: isAdmin(user) }
}

/** The domain rule for a Published file (CONTEXT.md), for queries that alias files as `f`. */
export const IS_PUBLISHED_SQL = `f.visibility = 'public' AND f.status = 'ready'`

/** Columns of a FileView; `$1` must be the viewer's id. Append WHERE/ORDER BY. */
export const FILE_VIEW_SELECT = `
  SELECT f.*,
         f.created_at::text AS created_at_exact,
         u.username AS owner_username,
         EXISTS (SELECT 1 FROM likes l WHERE l.file_id = f.id AND l.user_id = $1) AS liked_by_me
  FROM files f
  JOIN users u ON u.id = f.owner_id`

/**
 * Read gate: the owner, an admin, or anyone if the file is Published.
 * Returns null for "doesn't exist" and "not yours" alike, so callers answer 404 for both
 * and never confirm that a private file id exists.
 */
export async function findReadableFile(id: string, viewer: Viewer): Promise<FileView | null> {
  const { rows } = await pool.query<FileView>(
    `${FILE_VIEW_SELECT}
     WHERE f.id = $2 AND (f.owner_id = $1 OR $3 OR (${IS_PUBLISHED_SQL}))`,
    [viewer.id, id, viewer.isAdmin],
  )
  return rows[0] ?? null
}

/** Write gate: the owner only. Same 404 rule as findReadableFile. */
export async function findOwnedFile(id: string, ownerId: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [id, ownerId])
  return rows[0] ?? null
}

/**
 * Like gate: only Published files can be liked. Takes the transaction's client and locks
 * the row (FOR UPDATE) so the like and the like_count update see the same file state.
 */
export async function findPublishedFileForUpdate(client: PoolClient, id: string): Promise<FileRow | null> {
  const { rows } = await client.query<FileRow>(
    `SELECT f.* FROM files f WHERE f.id = $1 AND ${IS_PUBLISHED_SQL} FOR UPDATE`,
    [id],
  )
  return rows[0] ?? null
}

/** Full view for the owner (and admins): includes processing status and visibility. */
export function serializeFile(row: FileRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    visibility: row.visibility,
    likeCount: row.like_count,
    thumbnailUrl: thumbnailUrl(row),
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Narrow view for everyone else. A separate function (not a filtered copy of the full
 * view) so a new internal column can't leak to other users by default.
 */
export function serializePublicFile(view: FileView) {
  return {
    id: view.id,
    ownerUsername: view.owner_username,
    filename: view.filename,
    contentType: view.content_type,
    sizeBytes: Number(view.size_bytes),
    thumbnailUrl: thumbnailUrl(view),
    likeCount: view.like_count,
    likedByMe: view.liked_by_me,
    createdAt: view.created_at,
  }
}

export function serializeFileFor(view: FileView, viewer: Viewer) {
  const seesFullView = view.owner_id === viewer.id || viewer.isAdmin
  return seesFullView ? serializeFile(view) : serializePublicFile(view)
}

function thumbnailUrl(row: FileRow): string | null {
  return row.thumbnail_key ? s3.thumbnailPublicUrl(row.thumbnail_key) : null
}

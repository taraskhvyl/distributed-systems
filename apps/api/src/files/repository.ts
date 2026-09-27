import { PoolClient } from 'pg'
import { pool, withTransaction } from '../adapters/postgres.js'
import { insertOutboxEvent } from '../messaging/outbox.js'

// Repository: every SQL statement on `files` lives here. Services decide *what* to do;
// this module only knows *how* it is stored.

/** A row of the `files` table. */
export interface FileRow {
  id: string
  owner_id: string
  filename: string
  content_type: string
  size_bytes: string
  status: string
  visibility: Visibility
  like_count: number
  object_key: string
  thumbnail_key: string | null
  checksum: string | null
  created_at: Date
  updated_at: Date
}

export type Visibility = 'private' | 'public'

/** A file as one viewer sees it: the row plus its owner's name and the viewer's like. */
export interface FileView extends FileRow {
  owner_username: string
  liked_by_me: boolean
  /** created_at at full microsecond precision; a JS Date would truncate it (feed cursor). */
  created_at_exact: string
}

export interface NewFile {
  id: string
  ownerId: string
  filename: string
  contentType: string
  sizeBytes: number
  objectKey: string
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

export async function listOwnedFiles(ownerId: string, limit: number, offset: number): Promise<FileRow[]> {
  const { rows } = await pool.query<FileRow>(
    'SELECT * FROM files WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [ownerId, limit, offset],
  )
  return rows
}

export async function insertFile(file: NewFile): Promise<FileRow> {
  const { rows } = await pool.query<FileRow>(
    `INSERT INTO files (id, owner_id, filename, content_type, size_bytes, object_key)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [file.id, file.ownerId, file.filename, file.contentType, file.sizeBytes, file.objectKey],
  )
  return rows[0]
}

/**
 * Insert unless this owner already used `idempotencyKey`; null means it was used.
 * The unique index decides, so two concurrent retries can't both create a file.
 */
export async function insertFileOnce(file: NewFile, idempotencyKey: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>(
    `INSERT INTO files (id, owner_id, filename, content_type, size_bytes, object_key, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [file.id, file.ownerId, file.filename, file.contentType, file.sizeBytes, file.objectKey, idempotencyKey],
  )
  return rows[0] ?? null
}

export async function findFileByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>(
    'SELECT * FROM files WHERE owner_id = $1 AND idempotency_key = $2',
    [ownerId, idempotencyKey],
  )
  return rows[0] ?? null
}

export async function findFileById(id: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>('SELECT * FROM files WHERE id = $1', [id])
  return rows[0] ?? null
}

/**
 * Read gate: the owner, an admin, or anyone if the file is Published.
 * Returns null for "doesn't exist" and "not yours" alike, so callers answer 404 for both
 * and never confirm that a private file id exists.
 */
export async function findReadableFile(
  id: string,
  viewer: { id: string; isAdmin: boolean },
): Promise<FileView | null> {
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

export async function setVisibility(id: string, ownerId: string, visibility: Visibility): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>(
    `UPDATE files SET visibility = $3, updated_at = now()
     WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, visibility],
  )
  return rows[0] ?? null
}

/**
 * pending → uploaded plus the `file.uploaded` event, in one transaction (transactional
 * outbox): the processor hears about the file if and only if the status change committed.
 * The `status = 'pending'` guard makes a repeated complete a no-op without a second event.
 */
export async function markUploaded(file: FileRow): Promise<void> {
  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE files SET status = 'uploaded', updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [file.id],
    )
    const wasPending = updated.rowCount === 1
    if (!wasPending) return
    await insertOutboxEvent(client, 'file.uploaded', file.id, {
      fileId: file.id,
      objectKey: file.object_key,
      ownerId: file.owner_id,
      filename: file.filename,
      contentType: file.content_type,
      sizeBytes: Number(file.size_bytes),
    })
  })
}

export async function deleteFileRow(id: string): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = $1', [id])
}

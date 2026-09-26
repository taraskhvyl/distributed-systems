import crypto from 'node:crypto'
import { FastifyInstance } from 'fastify'
import { requireRole } from './auth.js'
import { config } from './config.js'
import { pool, withTransaction } from './db.js'
import {
  FileRow,
  findOwnedFile,
  findReadableFile,
  serializeFile,
  serializeFileFor,
  viewerOf,
} from './file-access.js'
import { insertOutboxEvent } from './outbox.js'
import * as s3 from './s3.js'

const UNSAFE_FILENAME = /[^a-zA-Z0-9._-]/g

/** Route schema for `/files/:id`: a malformed id is a 400, not a Postgres cast error (500). */
export const FILE_ID_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const

const NOT_FOUND = { error: { code: 'not_found', message: 'File not found' } }

export async function fileRoutes(app: FastifyInstance) {
  app.get('/files', async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100)
    const offset = Math.min(Math.max(Number(q.offset ?? 0) || 0, 0), 10000)
    const { rows } = await pool.query<FileRow>(
      'SELECT * FROM files WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.user!.id, limit, offset],
    )
    return { files: rows.map(serializeFile) }
  })

  app.get('/files/:id', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const viewer = viewerOf(req.user!)
    const file = await findReadableFile(id, viewer)
    if (!file) return reply.code(404).send(NOT_FOUND)
    return { file: serializeFileFor(file, viewer) }
  })

  app.post(
    '/files',
    {
      schema: {
        body: {
          type: 'object',
          required: ['filename', 'contentType', 'sizeBytes'],
          additionalProperties: false,
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 255 },
            contentType: {
              type: 'string',
              pattern: '^(image|text)/[a-zA-Z0-9.+-]+$|^application/pdf$',
            },
            sizeBytes: { type: 'integer', minimum: 1, maximum: config.maxUploadBytes },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { filename: string; contentType: string; sizeBytes: number }
      const id = crypto.randomUUID()
      const safeName = body.filename.replace(UNSAFE_FILENAME, '_').slice(0, 100)
      const objectKey = `${id}/${safeName}`
      const idempotencyKey = req.headers['idempotency-key']

      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        const inserted = await pool.query<FileRow>(
          `INSERT INTO files (id, owner_id, filename, content_type, size_bytes, object_key, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [id, req.user!.id, body.filename, body.contentType, body.sizeBytes, objectKey, idempotencyKey],
        )
        if (inserted.rows[0]) {
          const uploadUrl = await s3.presignUpload(objectKey, body.contentType)
          return reply.code(201).send({
            file: serializeFile(inserted.rows[0]),
            uploadUrl,
            uploadExpiresIn: config.presignUploadTtlSeconds,
          })
        }
        const existing = await pool.query<FileRow>(
          'SELECT * FROM files WHERE owner_id = $1 AND idempotency_key = $2',
          [req.user!.id, idempotencyKey],
        )
        const row = existing.rows[0]
        const uploadUrl = await s3.presignUpload(row.object_key, row.content_type)
        return reply.code(200).send({
          file: serializeFile(row),
          uploadUrl,
          uploadExpiresIn: config.presignUploadTtlSeconds,
          idempotentReplay: true,
        })
      }

      const inserted = await pool.query<FileRow>(
        `INSERT INTO files (id, owner_id, filename, content_type, size_bytes, object_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, req.user!.id, body.filename, body.contentType, body.sizeBytes, objectKey],
      )
      const uploadUrl = await s3.presignUpload(objectKey, body.contentType)
      return reply.code(201).send({
        file: serializeFile(inserted.rows[0]),
        uploadUrl,
        uploadExpiresIn: config.presignUploadTtlSeconds,
      })
    },
  )

  // Owner-only, in any status: a file is Published once it is public AND ready, so
  // making a still-processing file public is safe; it appears in feeds when ready.
  app.patch(
    '/files/:id',
    {
      schema: {
        params: FILE_ID_PARAMS,
        body: {
          type: 'object',
          required: ['visibility'],
          additionalProperties: false,
          properties: { visibility: { type: 'string', enum: ['private', 'public'] } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { visibility } = req.body as { visibility: FileRow['visibility'] }
      const { rows } = await pool.query<FileRow>(
        `UPDATE files SET visibility = $3, updated_at = now()
         WHERE id = $1 AND owner_id = $2 RETURNING *`,
        [id, req.user!.id, visibility],
      )
      if (!rows[0]) return reply.code(404).send(NOT_FOUND)
      return { file: serializeFile(rows[0]) }
    },
  )

  app.post('/files/:id/complete', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await findOwnedFile(id, req.user!.id)
    if (!row) return reply.code(404).send(NOT_FOUND)
    if (row.status !== 'pending') {
      return reply.code(409).send({
        error: { code: 'invalid_state', message: `File status is '${row.status}', expected 'pending'` },
      })
    }

    let head: { contentLength: number }
    try {
      head = await s3.headUpload(row.object_key)
    } catch {
      return reply.code(409).send({
        error: { code: 'not_uploaded', message: 'Object not found in storage; upload first' },
      })
    }
    if (head.contentLength !== Number(row.size_bytes)) {
      return reply.code(409).send({
        error: {
          code: 'size_mismatch',
          message: `Declared ${row.size_bytes} bytes but uploaded ${head.contentLength} bytes`,
        },
      })
    }

    await withTransaction(async (client) => {
      const upd = await client.query<FileRow>(
        `UPDATE files SET status = 'uploaded', updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id],
      )
      if (upd.rows[0]) {
        await insertOutboxEvent(client, 'file.uploaded', id, {
          fileId: id,
          objectKey: row.object_key,
          ownerId: row.owner_id,
          filename: row.filename,
          contentType: row.content_type,
          sizeBytes: Number(row.size_bytes),
        })
      }
    })

    return reply.code(202).send({ file: serializeFile({ ...row, status: 'uploaded' }) })
  })

  app.post('/files/:id/download-url', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const viewer = viewerOf(req.user!)
    const file = await findReadableFile(id, viewer)
    if (!file) return reply.code(404).send(NOT_FOUND)
    if (file.status === 'infected') {
      return reply.code(403).send({
        error: { code: 'blocked', message: 'File was rejected by the malware scanner' },
      })
    }
    if (!['uploaded', 'processing', 'ready'].includes(file.status)) {
      return reply.code(409).send({
        error: {
          code: file.status === 'pending' ? 'not_uploaded' : 'processing_failed',
          message: `File status is '${file.status}'`,
        },
      })
    }
    const url = await s3.presignDownload(file.object_key)
    return { url, expiresIn: config.presignDownloadTtlSeconds, file: serializeFileFor(file, viewer) }
  })

  app.delete(
    '/files/:id',
    { preHandler: requireRole('admin'), schema: { params: FILE_ID_PARAMS } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { rows } = await pool.query<FileRow>('SELECT * FROM files WHERE id = $1', [id])
      const row = rows[0]
      if (!row) return reply.code(404).send(NOT_FOUND)
      if (row.thumbnail_key) {
        await s3.deleteThumbnail(row.thumbnail_key).catch((err) => req.log.warn({ err }, 'thumbnail delete failed'))
      }
      await s3.deleteUpload(row.object_key).catch((err) => req.log.warn({ err }, 'object delete failed'))
      await pool.query('DELETE FROM files WHERE id = $1', [id])
      return reply.code(204).send()
    },
  )
}

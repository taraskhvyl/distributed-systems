import crypto from 'node:crypto'
import { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from './auth.js'
import { pool, withTransaction } from './db.js'
import { allowMutation } from './rate-limit.js'
import * as s3 from './s3.js'
import { config } from './config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNSAFE_FILENAME = /[^a-zA-Z0-9._-]/g

interface FileRow {
  id: string
  owner_id: string
  filename: string
  content_type: string
  size_bytes: string
  status: string
  object_key: string
  thumbnail_key: string | null
  checksum: string | null
  created_at: Date
  updated_at: Date
}

function serializeFile(row: FileRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    thumbnailUrl: row.thumbnail_key ? s3.thumbnailPublicUrl(row.thumbnail_key) : null,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function findOwnedFile(id: string, userId: string, isAdmin: boolean): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>('SELECT * FROM files WHERE id = $1', [id])
  const row = rows[0]
  if (!row) return null
  if (row.owner_id !== userId && !isAdmin) return null
  return row
}

export async function routes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' && req.method !== 'DELETE') return
    const allowed = await allowMutation(req.user!.id)
    if (!allowed) {
      reply.header('Retry-After', '10')
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many mutating requests, slow down' },
      })
    }
  })

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

  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid file id' } })
    }
    const row = await findOwnedFile(id, req.user!.id, req.user!.roles.includes('admin'))
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found' } })
    }
    return { file: serializeFile(row) }
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

  app.post('/files/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await findOwnedFile(id, req.user!.id, req.user!.roles.includes('admin'))
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found' } })
    }
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
        await client.query(
          `INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload)
           VALUES ($1, $2, 'file.uploaded', $3::jsonb)`,
          [
            crypto.randomUUID(),
            id,
            JSON.stringify({
              fileId: id,
              objectKey: row.object_key,
              ownerId: row.owner_id,
              filename: row.filename,
              contentType: row.content_type,
              sizeBytes: Number(row.size_bytes),
            }),
          ],
        )
      }
    })

    return reply.code(202).send({ file: serializeFile({ ...row, status: 'uploaded' }) })
  })

  app.post('/files/:id/download-url', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await findOwnedFile(id, req.user!.id, req.user!.roles.includes('admin'))
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found' } })
    }
    if (row.status === 'infected') {
      return reply.code(403).send({
        error: { code: 'blocked', message: 'File was rejected by the malware scanner' },
      })
    }
    if (!['uploaded', 'processing', 'ready'].includes(row.status)) {
      return reply.code(409).send({
        error: {
          code: row.status === 'pending' ? 'not_uploaded' : 'processing_failed',
          message: `File status is '${row.status}'`,
        },
      })
    }
    const url = await s3.presignDownload(row.object_key)
    return { url, expiresIn: config.presignDownloadTtlSeconds, file: serializeFile(row) }
  })

  app.delete('/files/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await pool.query<FileRow>('SELECT * FROM files WHERE id = $1', [id])
    const row = rows[0]
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'File not found' } })
    }
    if (row.thumbnail_key) {
      await s3.deleteThumbnail(row.thumbnail_key).catch((err) => req.log.warn({ err }, 'thumbnail delete failed'))
    }
    await s3.deleteUpload(row.object_key).catch((err) => req.log.warn({ err }, 'object delete failed'))
    await pool.query('DELETE FROM files WHERE id = $1', [id])
    return reply.code(204).send()
  })
}

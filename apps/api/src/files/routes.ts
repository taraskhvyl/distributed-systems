import { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { requireRole } from '../http/auth.js'
import { FILE_ID_PARAMS, FileIdParams } from '../http/schemas.js'
import { serializeFile, serializeFileFor, viewerOf } from './access.js'
import { Visibility } from './repository.js'
import * as files from './service.js'

// HTTP for files: validate input, call the service, shape the response. Errors thrown by
// the service (DomainError) become status codes in the app's error handler.

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_OFFSET = 10_000

const CREATE_FILE_BODY = {
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
} as const

const CHANGE_VISIBILITY_BODY = {
  type: 'object',
  required: ['visibility'],
  additionalProperties: false,
  properties: { visibility: { type: 'string', enum: ['private', 'public'] } },
} as const

export async function fileRoutes(app: FastifyInstance) {
  app.get('/files', async (req) => {
    const { limit, offset } = pageOf(req)
    const owned = await files.listOwnFiles(req.user!.id, limit, offset)
    return { files: owned.map(serializeFile) }
  })

  app.get('/files/:id', { schema: { params: FILE_ID_PARAMS } }, async (req) => {
    const { id } = req.params as FileIdParams
    const viewer = viewerOf(req.user!)
    const file = await files.getReadableFile(id, viewer)
    return { file: serializeFileFor(file, viewer) }
  })

  app.post('/files', { schema: { body: CREATE_FILE_BODY } }, async (req, reply) => {
    const upload = await files.registerUpload(req.user!.id, req.body as files.UploadRequest, idempotencyKeyOf(req))
    const body: Record<string, unknown> = {
      file: serializeFile(upload.file),
      uploadUrl: upload.uploadUrl,
      uploadExpiresIn: config.presignUploadTtlSeconds,
    }
    if (upload.replayed) body.idempotentReplay = true
    return reply.code(upload.replayed ? 200 : 201).send(body)
  })

  app.patch(
    '/files/:id',
    { schema: { params: FILE_ID_PARAMS, body: CHANGE_VISIBILITY_BODY } },
    async (req) => {
      const { id } = req.params as FileIdParams
      const { visibility } = req.body as { visibility: Visibility }
      const file = await files.changeVisibility(id, req.user!.id, visibility)
      return { file: serializeFile(file) }
    },
  )

  // 202: accepted, processing happens asynchronously (watch status or the SSE stream).
  app.post('/files/:id/complete', { schema: { params: FILE_ID_PARAMS } }, async (req, reply) => {
    const { id } = req.params as FileIdParams
    const file = await files.completeUpload(id, req.user!.id)
    return reply.code(202).send({ file: serializeFile(file) })
  })

  app.post('/files/:id/download-url', { schema: { params: FILE_ID_PARAMS } }, async (req) => {
    const { id } = req.params as FileIdParams
    const viewer = viewerOf(req.user!)
    const download = await files.prepareDownload(id, viewer)
    return {
      url: download.url,
      expiresIn: config.presignDownloadTtlSeconds,
      file: serializeFileFor(download.file, viewer),
    }
  })

  app.delete(
    '/files/:id',
    { preHandler: requireRole('admin'), schema: { params: FILE_ID_PARAMS } },
    async (req, reply) => {
      const { id } = req.params as FileIdParams
      await files.deleteFile(id, req.log)
      return reply.code(204).send()
    },
  )
}

/** Lenient paging: out-of-range values are clamped, not rejected. */
function pageOf(req: FastifyRequest): { limit: number; offset: number } {
  const query = req.query as { limit?: string; offset?: string }
  const requestedLimit = Number(query.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE
  const requestedOffset = Number(query.offset ?? 0) || 0
  return {
    limit: clamp(requestedLimit, 1, MAX_PAGE_SIZE),
    offset: clamp(requestedOffset, 0, MAX_OFFSET),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function idempotencyKeyOf(req: FastifyRequest): string | null {
  const header = req.headers['idempotency-key']
  const hasKey = typeof header === 'string' && header.length > 0
  return hasKey ? header : null
}

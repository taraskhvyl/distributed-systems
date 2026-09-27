import crypto from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import * as s3 from '../adapters/s3.js'
import { DomainError, fileNotFound } from '../errors.js'
import { Viewer } from './access.js'
import * as repository from './repository.js'
import { FileRow, FileView, NewFile, Visibility } from './repository.js'

// What each file operation does, step by step. No HTTP (routes.ts) and no SQL (repository.ts).
//
// Upload lifecycle: registerUpload (row `pending` + presigned PUT URL) → the client PUTs
// the bytes straight to S3 → completeUpload (verify the object, `uploaded` + event) → the
// processor scans and thumbnails it → `ready` or `infected`/`failed`.

const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g
const MAX_OBJECT_KEY_FILENAME_LENGTH = 100
const DOWNLOADABLE_STATUSES = new Set(['uploaded', 'processing', 'ready'])

export interface UploadRequest {
  filename: string
  contentType: string
  sizeBytes: number
}

export interface RegisteredUpload {
  file: FileRow
  uploadUrl: string
  /** True when an Idempotency-Key matched an earlier request: `file` is that request's file. */
  replayed: boolean
}

export async function listOwnFiles(ownerId: string, limit: number, offset: number): Promise<FileRow[]> {
  return repository.listOwnedFiles(ownerId, limit, offset)
}

export async function getReadableFile(id: string, viewer: Viewer): Promise<FileView> {
  const file = await repository.findReadableFile(id, viewer)
  if (!file) throw fileNotFound()
  return file
}

/**
 * Step 1 of an upload. With an Idempotency-Key, a retried request (client timeout, lost
 * response) returns the first file and a fresh URL instead of creating a twin.
 */
export async function registerUpload(
  ownerId: string,
  request: UploadRequest,
  idempotencyKey: string | null,
): Promise<RegisteredUpload> {
  const id = crypto.randomUUID()
  const newFile: NewFile = { id, ownerId, ...request, objectKey: objectKeyFor(id, request.filename) }
  const { file, replayed } = await insertOrReplay(newFile, idempotencyKey)
  const uploadUrl = await s3.presignUpload(file.object_key, file.content_type)
  return { file, uploadUrl, replayed }
}

async function insertOrReplay(newFile: NewFile, idempotencyKey: string | null) {
  if (!idempotencyKey) {
    return { file: await repository.insertFile(newFile), replayed: false }
  }
  const inserted = await repository.insertFileOnce(newFile, idempotencyKey)
  if (inserted) return { file: inserted, replayed: false }

  const earlier = await repository.findFileByIdempotencyKey(newFile.ownerId, idempotencyKey)
  if (!earlier) throw new Error('idempotency key conflicted but no file holds it')
  return { file: earlier, replayed: true }
}

/** The file id keeps keys unique; the sanitized name keeps them readable in the bucket. */
function objectKeyFor(fileId: string, filename: string): string {
  const safeName = filename.replace(UNSAFE_FILENAME_CHARS, '_').slice(0, MAX_OBJECT_KEY_FILENAME_LENGTH)
  return `${fileId}/${safeName}`
}

/**
 * Step 3 of an upload: the client says the PUT is done. Trust but verify: the object
 * must exist with the declared size before the processor is told about it.
 */
export async function completeUpload(id: string, ownerId: string): Promise<FileRow> {
  const file = await repository.findOwnedFile(id, ownerId)
  if (!file) throw fileNotFound()
  if (file.status !== 'pending') {
    throw new DomainError('invalid_state', `File status is '${file.status}', expected 'pending'`)
  }
  await assertUploadedAsDeclared(file)
  await repository.markUploaded(file)
  return { ...file, status: 'uploaded' }
}

async function assertUploadedAsDeclared(file: FileRow): Promise<void> {
  const stored = await s3.headUpload(file.object_key)
  if (!stored) {
    throw new DomainError('not_uploaded', 'Object not found in storage; upload first')
  }
  const declaredBytes = Number(file.size_bytes)
  if (stored.contentLength !== declaredBytes) {
    throw new DomainError(
      'size_mismatch',
      `Declared ${declaredBytes} bytes but uploaded ${stored.contentLength} bytes`,
    )
  }
}

/**
 * Owner-only, in any status: a file is Published once it is public AND ready, so making a
 * still-processing file public is safe; it appears in feeds when ready.
 */
export async function changeVisibility(id: string, ownerId: string, visibility: Visibility): Promise<FileRow> {
  const file = await repository.setVisibility(id, ownerId, visibility)
  if (!file) throw fileNotFound()
  return file
}

export async function prepareDownload(id: string, viewer: Viewer): Promise<{ url: string; file: FileView }> {
  const file = await getReadableFile(id, viewer)
  assertDownloadable(file)
  const url = await s3.presignDownload(file.object_key)
  return { url, file }
}

function assertDownloadable(file: FileRow): void {
  if (file.status === 'infected') {
    throw new DomainError('blocked', 'File was rejected by the malware scanner')
  }
  if (!DOWNLOADABLE_STATUSES.has(file.status)) {
    const code = file.status === 'pending' ? 'not_uploaded' : 'processing_failed'
    throw new DomainError(code, `File status is '${file.status}'`)
  }
}

/**
 * Admin delete. Storage deletes are best effort: a failure leaves an orphan object (logged),
 * never a row that points at nothing.
 */
export async function deleteFile(id: string, log: FastifyBaseLogger): Promise<void> {
  const file = await repository.findFileById(id)
  if (!file) throw fileNotFound()
  if (file.thumbnail_key) {
    await s3.deleteThumbnail(file.thumbnail_key).catch((err) => log.warn({ err }, 'thumbnail delete failed'))
  }
  await s3.deleteUpload(file.object_key).catch((err) => log.warn({ err }, 'object delete failed'))
  await repository.deleteFileRow(id)
}

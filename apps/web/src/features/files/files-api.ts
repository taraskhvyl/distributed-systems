// The api's /files endpoints (your own files). HTTP only; state lives in use-own-files.ts.
import { request } from '@/adapters/http'
import { putToPresignedUrl } from '@/adapters/s3-upload'

/** Your own File: the full view (status, visibility). */
export interface OwnFile {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  status: 'pending' | 'uploaded' | 'processing' | 'ready' | 'infected' | 'failed'
  visibility: 'public' | 'private'
  likeCount: number
  thumbnailUrl: string | null
  createdAt: string
}

const OWN_FILES_PAGE_SIZE = 50

export async function listFiles() {
  const { files } = await request<{ files: OwnFile[] }>('GET', `/files?limit=${OWN_FILES_PAGE_SIZE}`)
  return files
}

export async function setVisibility(fileId: string, visibility: OwnFile['visibility']) {
  const { file } = await request<{ file: OwnFile }>('PATCH', `/files/${fileId}`, { body: { visibility } })
  return file
}

/** Works for your files and for Published files in the Feed. */
export async function getDownloadUrl(fileId: string) {
  const { url } = await request<{ url: string }>('POST', `/files/${fileId}/download-url`)
  return url
}

/**
 * The three-step upload: register metadata (get a presigned URL), PUT the bytes straight
 * to S3, then tell the api the upload is complete (which starts processing).
 */
export async function uploadFile(file: File, onProgress: (fraction: number) => void) {
  const created = await request<{ file: OwnFile; uploadUrl: string }>('POST', '/files', {
    body: { filename: file.name, contentType: file.type, sizeBytes: file.size },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
  await putToPresignedUrl(created.uploadUrl, file, onProgress)
  await request('POST', `/files/${created.file.id}/complete`)
  return created.file
}

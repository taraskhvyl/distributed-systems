// Calls to the mediashare api, plus the direct-to-S3 upload.
import { API_URL } from './config.js'
import { accessToken } from './auth.js'

export class ApiError extends Error {
  constructor(method, path, status) {
    super(`${method} ${path}: HTTP ${status}`)
    this.status = status
  }
}

async function request(method, path, { body, headers = {} } = {}) {
  const requestHeaders = { Authorization: `Bearer ${await accessToken()}`, ...headers }
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new ApiError(method, path, res.status)
  return res.status === 204 ? null : res.json()
}

export async function listFiles() {
  const { files } = await request('GET', '/files?limit=50')
  return files
}

export async function getDownloadUrl(fileId) {
  const { url } = await request('POST', `/files/${fileId}/download-url`)
  return url
}

/**
 * The three-step upload: register metadata (get a presigned URL), PUT the bytes straight
 * to S3, then tell the api the upload is complete (which starts processing).
 */
export async function uploadFile(file, onProgress) {
  const created = await request('POST', '/files', {
    body: { filename: file.name, contentType: file.type, sizeBytes: file.size },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
  await putToPresignedUrl(created.uploadUrl, file, onProgress)
  await request('POST', `/files/${created.file.id}/complete`)
  return created.file
}

// fetch() has no upload-progress events; XMLHttpRequest does (xhr.upload.onprogress).
function putToPresignedUrl(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status < 300) resolve()
      else reject(new Error(`S3 PUT: HTTP ${xhr.status}`))
    }
    // A CORS rejection looks exactly like this: status 0 and no details for JS.
    xhr.onerror = () => reject(new Error('S3 PUT: network error (CORS? see DevTools console)'))
    xhr.send(file)
  })
}

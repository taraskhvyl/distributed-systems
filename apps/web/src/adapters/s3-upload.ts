// Adapter for the direct-to-S3 upload with a presigned URL (no api, no token involved).

/** PUTs the bytes to the presigned URL, reporting progress as a 0..1 fraction. */
export function putToPresignedUrl(url: string, file: File, onProgress: (fraction: number) => void) {
  // fetch() has no upload-progress events; XMLHttpRequest does (xhr.upload.onprogress).
  return new Promise<void>((resolve, reject) => {
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

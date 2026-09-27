import { reportError } from '@/features/log/report'
import { getDownloadUrl } from './files-api'

/** Asks the api for a short-lived presigned URL, then lets the browser download from S3. */
export async function downloadFile(fileId: string) {
  try {
    location.assign(await getDownloadUrl(fileId))
  } catch (err) {
    reportError(err)
  }
}

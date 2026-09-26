import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from './config.js'

const base = {
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const

const internal = new S3Client({ ...base, endpoint: config.s3.internalEndpoint })
const external = new S3Client({ ...base, endpoint: config.s3.publicEndpoint })

export async function presignUpload(objectKey: string, contentType: string): Promise<string> {
  return getSignedUrl(
    external,
    new PutObjectCommand({
      Bucket: config.s3.uploadsBucket,
      Key: objectKey,
      ContentType: contentType,
    }),
    { expiresIn: config.presignUploadTtlSeconds },
  )
}

export async function presignDownload(objectKey: string): Promise<string> {
  return getSignedUrl(
    external,
    new GetObjectCommand({
      Bucket: config.s3.uploadsBucket,
      Key: objectKey,
    }),
    { expiresIn: config.presignDownloadTtlSeconds },
  )
}

export async function headUpload(objectKey: string): Promise<{ contentLength: number }> {
  try {
    const out = await internal.send(
      new HeadObjectCommand({ Bucket: config.s3.uploadsBucket, Key: objectKey }),
    )
    return { contentLength: out.ContentLength ?? 0 }
  } catch {
    throw new Error('object_not_found')
  }
}

export async function deleteUpload(objectKey: string): Promise<void> {
  await internal.send(
    new DeleteObjectCommand({ Bucket: config.s3.uploadsBucket, Key: objectKey }),
  )
}

export async function deleteThumbnail(thumbnailKey: string): Promise<void> {
  await internal.send(
    new DeleteObjectCommand({ Bucket: config.s3.thumbnailsBucket, Key: thumbnailKey }),
  )
}

export function thumbnailPublicUrl(thumbnailKey: string): string {
  return `${config.s3.publicEndpoint}/${config.s3.thumbnailsBucket}/${thumbnailKey}`
}

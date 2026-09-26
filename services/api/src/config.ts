const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','),
  authIssuer: required('AUTH_ISSUER'),
  authJwksUrl: required('AUTH_JWKS_URL'),
  webOrigin: required('WEB_ORIGIN'),
  s3: {
    region: 'us-east-1',
    internalEndpoint: required('S3_ENDPOINT_INTERNAL'),
    publicEndpoint: required('S3_ENDPOINT_PUBLIC'),
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
    uploadsBucket: process.env.S3_UPLOADS_BUCKET ?? 'media-uploads',
    thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET ?? 'media-thumbnails',
  },
  presignUploadTtlSeconds: 600,
  presignDownloadTtlSeconds: 300,
  maxUploadBytes: 200 * 1024 * 1024,
  topicMain: 'file-events',
  rateLimit: { capacity: 5, refillPerSecond: 0.5 },
}

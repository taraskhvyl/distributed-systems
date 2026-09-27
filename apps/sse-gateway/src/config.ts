function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  authIssuer: required('AUTH_ISSUER'),
  authJwksUrl: required('AUTH_JWKS_URL'),
  webOrigin: required('WEB_ORIGIN'),
  redisUrl: required('REDIS_URL'),
}

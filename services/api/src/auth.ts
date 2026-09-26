import { FastifyReply, FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from './config.js'

const jwks = createRemoteJWKSet(new URL(config.authJwksUrl), {
  cacheMaxAge: 10 * 60 * 1000,
  cooldownDuration: 30 * 1000,
})

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({
      error: { code: 'unauthorized', message: 'Missing bearer token' },
    })
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer: config.authIssuer,
      requiredClaims: ['exp', 'iat', 'iss', 'sub'],
      clockTolerance: 5,
    })
    const realmAccess = payload.realm_access as { roles?: string[] } | undefined
    req.user = {
      id: payload.sub as string,
      roles: realmAccess?.roles ?? [],
    }
  } catch {
    return reply.code(401).send({
      error: { code: 'invalid_token', message: 'Token validation failed' },
    })
  }
}

export function requireRole(role: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.roles.includes(role)) {
      return reply.code(403).send({
        error: { code: 'forbidden', message: `Requires role: ${role}` },
      })
    }
  }
}

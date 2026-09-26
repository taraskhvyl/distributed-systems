import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthError, createTokenVerifier } from '@mediashare/auth'
import { config } from './config.js'

const verifyAuthorizationHeader = createTokenVerifier({
  issuer: config.authIssuer,
  jwksUrl: config.authJwksUrl,
})

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = await verifyAuthorizationHeader(req.headers.authorization)
    req.user = { id: user.id, roles: user.roles }
  } catch (err) {
    if (!(err instanceof AuthError)) throw err
    return reply.code(401).send({ error: { code: err.code, message: err.message } })
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

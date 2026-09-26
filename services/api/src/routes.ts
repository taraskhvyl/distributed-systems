import { FastifyInstance } from 'fastify'
import { authenticate } from './auth.js'
import { fileRoutes } from './file-routes.js'
import { rateLimitMutations } from './rate-limit.js'
import { socialRoutes } from './social-routes.js'
import { rememberUser } from './users.js'

/** Every /v1 route: authenticate → mirror the user locally → rate-limit writes → handler. */
export async function routes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', rememberUser)
  app.addHook('preHandler', rateLimitMutations)

  await app.register(fileRoutes)
  await app.register(socialRoutes)
}

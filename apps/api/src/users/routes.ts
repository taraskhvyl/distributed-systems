import { FastifyInstance } from 'fastify'
import { USERNAME_PARAMS, UsernameParams } from '../http/schemas.js'
import * as users from './service.js'

const USER_SEARCH_QUERY = {
  type: 'object',
  required: ['q'],
  properties: { q: { type: 'string', minLength: 1, maxLength: 255 } },
} as const

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', { schema: { querystring: USER_SEARCH_QUERY } }, async (req) => {
    const { q } = req.query as { q: string }
    return { users: await users.searchUsers(req.user!.id, q) }
  })

  app.get('/users/:username', { schema: { params: USERNAME_PARAMS } }, async (req) => {
    const { username } = req.params as UsernameParams
    return { user: await users.getProfile(req.user!.id, username) }
  })
}

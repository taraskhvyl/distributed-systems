import { FastifyInstance } from 'fastify'
import { serializePublicFile } from '../files/access.js'
import { FILE_ID_PARAMS, FileIdParams, USERNAME_PARAMS, UsernameParams } from '../http/schemas.js'
import * as social from './service.js'

const FEED_DEFAULT_LIMIT = 20
const FEED_MAX_LIMIT = 50

const FEED_QUERY = {
  type: 'object',
  properties: {
    cursor: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: FEED_MAX_LIMIT, default: FEED_DEFAULT_LIMIT },
  },
} as const

export async function socialRoutes(app: FastifyInstance) {
  // PUT/DELETE because follow and like are states: repeating a request changes nothing.
  app.put('/users/:username/follow', { schema: { params: USERNAME_PARAMS } }, async (req) => {
    const { username } = req.params as UsernameParams
    await social.follow(req.user!.id, username)
    return { following: true }
  })

  app.delete('/users/:username/follow', { schema: { params: USERNAME_PARAMS } }, async (req) => {
    const { username } = req.params as UsernameParams
    await social.unfollow(req.user!.id, username)
    return { following: false }
  })

  app.put('/files/:id/like', { schema: { params: FILE_ID_PARAMS } }, async (req) => {
    const { id } = req.params as FileIdParams
    const { likeCount } = await social.like(id, req.user!)
    return { liked: true, likeCount }
  })

  app.delete('/files/:id/like', { schema: { params: FILE_ID_PARAMS } }, async (req) => {
    const { id } = req.params as FileIdParams
    const { likeCount } = await social.unlike(id, req.user!.id)
    return { liked: false, likeCount }
  })

  app.get('/feed', { schema: { querystring: FEED_QUERY } }, async (req) => {
    const { cursor, limit } = req.query as { cursor?: string; limit: number }
    const page = await social.readFeedPage(req.user!.id, cursor, limit)
    return { files: page.files.map(serializePublicFile), nextCursor: page.nextCursor }
  })
}

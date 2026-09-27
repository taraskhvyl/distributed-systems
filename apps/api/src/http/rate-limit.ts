import { FastifyReply, FastifyRequest } from 'fastify'
import { redis } from '../adapters/redis.js'
import { config } from '../config.js'

declare module 'ioredis' {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: number,
      refillPerMs: number,
      nowMs: number,
    ): Promise<number>
  }
}

// Safe methods (RFC 9110) don't change state, so they don't cost a token.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const RETRY_AFTER_SECONDS = '10'

// Token bucket in one Lua script: read, refill, take, write happen atomically in Redis,
// so concurrent requests from many api replicas can't both spend the last token.
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
if tokens == nil then tokens = capacity end
local ts = tonumber(data[2])
if ts == nil then ts = nowMs end
tokens = math.min(capacity, tokens + (nowMs - ts) * refillPerMs)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', nowMs)
redis.call('EXPIRE', key, math.ceil(capacity / (refillPerMs * 1000)) + 60)
return allowed
`

redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA })

/** Fails open: if Redis is down, requests are allowed rather than the whole api failing. */
async function allowMutation(userId: string): Promise<boolean> {
  try {
    const allowed = await redis.tokenBucket(
      `rl:mutate:${userId}`,
      config.rateLimit.capacity,
      config.rateLimit.refillPerSecond / 1000,
      Date.now(),
    )
    return allowed === 1
  } catch {
    return true
  }
}

/** Hook: one token per state-changing request (POST, PUT, PATCH, DELETE), per user. */
export async function rateLimitMutations(req: FastifyRequest, reply: FastifyReply) {
  if (SAFE_METHODS.has(req.method)) return
  const allowed = await allowMutation(req.user!.id)
  if (allowed) return
  reply.header('Retry-After', RETRY_AFTER_SECONDS)
  return reply.code(429).send({
    error: { code: 'rate_limited', message: 'Too many mutating requests, slow down' },
  })
}

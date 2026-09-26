import { Redis } from 'ioredis'
import { config } from './config.js'

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

const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
})

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

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export async function redisPing(): Promise<void> {
  const reply = (await redis.ping()) as string
  if (reply !== 'PONG') throw new Error('redis ping failed')
}

export async function allowMutation(userId: string): Promise<boolean> {
  try {
    const allowed = (await redis.tokenBucket(
      `rl:mutate:${userId}`,
      config.rateLimit.capacity,
      config.rateLimit.refillPerSecond / 1000,
      Date.now(),
    )) as number
    return allowed === 1
  } catch {
    return true
  }
}

import { Redis } from 'ioredis'
import { config } from '../config.js'

// Adapter: the process's one Redis client.
// enableOfflineQueue: false makes commands fail fast while Redis is down instead of queueing,
// so callers (the rate limiter) can decide to fail open.
export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
})

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export async function redisPing(): Promise<void> {
  const reply = (await redis.ping()) as string
  if (reply !== 'PONG') throw new Error('redis ping failed')
}

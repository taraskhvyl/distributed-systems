import { createProducer } from './adapters/kafka.js'
import { pool } from './adapters/postgres.js'
import { connectRedis } from './adapters/redis.js'
import { config } from './config.js'
import { buildApp } from './http/app.js'
import { startOutboxRelay } from './messaging/outbox.js'

// Composition root: builds the pieces, connects them, starts them, stops them. No logic.

const STARTUP_ATTEMPTS = 20
const STARTUP_RETRY_DELAY_MS = 3000

/** Kafka and Redis may still be starting when we do (compose has no ordering for them). */
async function retryOnStartup<T>(connect: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect()
    } catch (err) {
      if (attempt >= STARTUP_ATTEMPTS) throw err
      console.error(`retryable failure (${attempt}/${STARTUP_ATTEMPTS}), retrying in ${STARTUP_RETRY_DELAY_MS}ms`, err)
      await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS))
    }
  }
}

async function main() {
  const app = await buildApp()

  const producer = createProducer()
  await retryOnStartup(() => producer.connect())
  await retryOnStartup(() => connectRedis())

  // Scalability: every replica runs a relay. FOR UPDATE SKIP LOCKED is meant to keep them
  // from publishing the same row twice (messaging/outbox.ts); verified in roadmap Phase 3.
  const stopRelay = startOutboxRelay(pool, producer, app.log, config.topicMain)

  await app.listen({ port: config.port, host: '0.0.0.0' })

  const shutdown = async () => {
    stopRelay()
    await app.close().catch(() => {})
    await pool.end().catch(() => {})
    await producer.disconnect().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('fatal startup error', err)
  process.exit(1)
})

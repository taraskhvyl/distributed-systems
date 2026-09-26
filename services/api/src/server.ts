import Fastify from 'fastify'
import { Admin, Kafka, Producer } from 'kafkajs'
import { config } from './config.js'
import { pool } from './db.js'
import { connectRedis, redisPing } from './rate-limit.js'
import { routes } from './routes.js'
import { startOutboxRelay } from './outbox.js'

async function retry<T>(fn: () => Promise<T>, attempts = 20, delayMs = 3000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts) throw err
      console.error(`retryable failure (${i}/${attempts}), retrying in ${delayMs}ms`, err)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function ensureTopics(admin: Admin): Promise<void> {
  await admin.connect()
  try {
    await admin.createTopics({
      topics: [
        { topic: 'file-events', numPartitions: 3, replicationFactor: 1 },
        { topic: 'file-events-retry', numPartitions: 3, replicationFactor: 1 },
        {
          topic: 'file-events-dlq',
          numPartitions: 1,
          replicationFactor: 1,
          configEntries: [{ name: 'retention.ms', value: '604800000' }],
        },
      ],
      waitForLeaders: true,
    })
  } catch (err) {
    const message = String(err)
    if (!message.includes('already exists')) throw err
  } finally {
    await admin.disconnect()
  }
}

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
    },
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      await redisPing()
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled error')
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'Request body failed validation' },
      })
    }
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } })
  })

  await app.register(routes, { prefix: '/v1' })

  const kafka = new Kafka({
    clientId: 'mediashare-api',
    brokers: config.kafkaBrokers,
    retry: { retries: 10 },
  })
  const producer: Producer = kafka.producer()
  await retry(() => producer.connect())
  await retry(() => ensureTopics(kafka.admin()))
  await retry(() => connectRedis())

  startOutboxRelay(pool, producer, app.log, config.topicMain)

  await app.listen({ port: config.port, host: '0.0.0.0' })

  const shutdown = async () => {
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

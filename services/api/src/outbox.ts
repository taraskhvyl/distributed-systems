import crypto from 'node:crypto'
import { Producer } from 'kafkajs'
import { Pool, PoolClient } from 'pg'
import { FastifyBaseLogger } from 'fastify'

/**
 * Transactional outbox: call inside the transaction that makes the change, so the event
 * exists if and only if the change committed. The relay below publishes it later.
 * `aggregateId` becomes the Kafka key, so events for one file stay ordered.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [crypto.randomUUID(), aggregateId, eventType, JSON.stringify(payload)],
  )
}

export function startOutboxRelay(
  pool: Pool,
  producer: Producer,
  log: FastifyBaseLogger,
  topic: string,
  intervalMs = 250,
): () => void {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id, event_id, aggregate_id, event_type, payload, created_at
         FROM outbox_events
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT 100
         FOR UPDATE SKIP LOCKED`,
      )
      for (const row of rows) {
        const envelope = {
          eventId: row.event_id,
          eventType: row.event_type,
          aggregateId: row.aggregate_id,
          occurredAt: row.created_at,
          payload: row.payload,
        }
        await producer.send({
          topic,
          messages: [{ key: row.aggregate_id, value: JSON.stringify(envelope) }],
        })
      }
      if (rows.length > 0) {
        const ids = rows.map((r: { id: number }) => r.id)
        await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [
          ids,
        ])
        log.info(
          { count: rows.length, eventTypes: rows.map((r: { event_type: string }) => r.event_type) },
          'outbox relay published events',
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      log.error({ err }, 'outbox relay tick failed, will retry')
    } finally {
      client.release()
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

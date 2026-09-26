import crypto from 'node:crypto'
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { Producer } from 'kafkajs'
import { Pool, PoolClient } from 'pg'
import { FastifyBaseLogger } from 'fastify'

const tracer = trace.getTracer('mediashare-api/outbox')

type OutboxRow = {
  id: number
  event_id: string
  aggregate_id: string
  event_type: string
  payload: unknown
  traceparent: string | null
  created_at: Date
}

/**
 * Transactional outbox: call inside the transaction that makes the change, so the event
 * exists if and only if the change committed. The relay below publishes it later.
 * `aggregateId` becomes the Kafka key, so events for one file stay ordered.
 * The caller's trace context is stored with the row, so the relay can continue the trace.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload, traceparent)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [crypto.randomUUID(), aggregateId, eventType, JSON.stringify(payload), currentTraceparent()],
  )
}

/** The active trace as a W3C `traceparent` string, or null when called outside a trace. */
function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  return carrier.traceparent ?? null
}

/**
 * Sends one outbox row to Kafka inside the trace of the request that wrote it.
 * The kafkajs instrumentation then copies the active trace into the message headers.
 * `outbox.delay_ms` is how long the event waited in the table (the outbox lag).
 */
async function publishRow(producer: Producer, topic: string, row: OutboxRow): Promise<void> {
  const carrier = row.traceparent ? { traceparent: row.traceparent } : {}
  // Built from ROOT_CONTEXT, so it also leaves the poll's suppressTracing behind.
  const requestContext = propagation.extract(ROOT_CONTEXT, carrier)
  const attributes = {
    'outbox.event_id': row.event_id,
    'outbox.event_type': row.event_type,
    'outbox.delay_ms': Date.now() - row.created_at.getTime(),
  }
  await tracer.startActiveSpan('outbox publish', { attributes }, requestContext, async (span) => {
    try {
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
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      throw err
    } finally {
      span.end()
    }
  })
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
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, event_id, aggregate_id, event_type, payload, traceparent, created_at
         FROM outbox_events
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT 100
         FOR UPDATE SKIP LOCKED`,
      )
      for (const row of rows) {
        await publishRow(producer, topic, row)
      }
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id)
        await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [
          ids,
        ])
        log.info(
          { count: rows.length, eventTypes: rows.map((r) => r.event_type) },
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

  // The poll runs 4x/s and usually finds nothing. Untraced, every tick would become orphan
  // root traces (BEGIN/SELECT/COMMIT). Events still get spans: see publishRow.
  const untracedTick = () => context.with(suppressTracing(context.active()), tick)
  const timer = setInterval(untracedTick, intervalMs)
  return () => clearInterval(timer)
}

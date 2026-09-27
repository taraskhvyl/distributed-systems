import { Pool, PoolClient } from 'pg'
import { config } from '../config.js'

// Adapter: the process's one Postgres pool. Repositories import it; nothing else talks SQL.
// Scalability: `max` is per replica, so N api replicas open up to N × 10 connections.
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 })

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function postgresPing(): Promise<void> {
  await pool.query('SELECT 1')
}

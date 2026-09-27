// Adapter around fetch() for the mediashare api: bearer token, trace context, JSON, errors.
// Feature *-api.ts modules call this; nothing else talks HTTP to the api.
import { API_URL } from '@/config'
import { accessToken } from '@/features/auth/token-store'
import { newTraceparent } from './traceparent'

export class ApiError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
  ) {
    super(`${method} ${path}: HTTP ${status}`)
  }
}

interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
}

export async function request<T>(method: string, path: string, { body, headers = {} }: RequestOptions = {}): Promise<T> {
  const { traceId, traceparent } = newTraceparent()
  // Paste the id into Grafana → Explore → Tempo to see this click's whole trace.
  console.info(`[trace] ${method} ${path} traceId=${traceId}`)
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    traceparent,
    ...headers,
  }
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new ApiError(method, path, res.status)
  return res.status === 204 ? (null as T) : res.json()
}

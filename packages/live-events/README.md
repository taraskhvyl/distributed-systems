# @mediashare/live-events

The contract between `apps/notifier` (publisher) and `apps/sse-gateway` (subscriber): one
Redis pub/sub channel and the message format on it. A **Live event** (see `CONTEXT.md`) is
what gets written to one user's open browser tabs.

```ts
import { LIVE_EVENTS_CHANNEL, decodeLiveEvent, encodeLiveEvent } from '@mediashare/live-events'

// notifier
await redis.publish(LIVE_EVENTS_CHANNEL, encodeLiveEvent({ userId, eventName, data }))

// sse-gateway
const decoded = decodeLiveEvent(raw)          // null if malformed
if (decoded) context.with(decoded.publisherContext, () => deliver(decoded.event))
```

## Why it exists

The two services are deployed separately and talk only through Redis, so nothing checks
that they agree on the format at runtime: a mismatch just delivers nothing, silently. With
one definition, renaming a field fails the build of **both** services (tried: 5 compile
errors). The compiler sees one commit only, so during a rolling deploy fields may be added,
never renamed or removed in one step.

## Trace context

Redis pub/sub has no headers, and OpenTelemetry's auto-instrumentation stops at this hop.
`encodeLiveEvent` puts the active trace context into the message; `decodeLiveEvent` returns
it as `publisherContext`, so the subscriber's `sse.publish` span continues the same trace
(api → Kafka → notifier → Redis → sse-gateway, one trace in Grafana).

## Also know

- The channel name is repeated in the Redis ACL (`&sse-events` in `compose/data.yml`):
  change both.
- `@opentelemetry/api` is a peer dependency, so the package uses the service's copy and
  the trace isn't split across two API instances.

---
status: accepted
---

# The browser's SSE stream is served by its own service, not by the Kafka consumer

`GET /v1/events` must be reachable from the internet (through Envoy). The notifier, which
consumes Kafka, used to serve it, so it sat on `edge` and `data` at once and held the full
Redis password. Kafka here has no authentication (`PLAINTEXT`): any container on `data`
can read and write every topic. One bug in the stream's HTTP handling would have been a
path from the internet to Kafka and to every Redis key.

Decision: split along that line.

- **notifier**: Kafka consumer on `data` only, no HTTP server. Publishes live events to the
  Redis channel `sse-events`.
- **sse-gateway** (`apps/sse-gateway`): the SSE endpoint. Networks `edge` + `sse`, where
  `sse` holds only redis and lgtm, so Kafka and Postgres don't resolve from it.
- **Redis ACL users** (`compose/data.yml`): `sse-gateway` may only `SUBSCRIBE sse-events`,
  `notifier` may only `PUBLISH sse-events`. `default` keeps full access for api and
  ratelimit.

The Redis pub/sub between them already existed for replica fan-out (Phase 3), so the split
added a boundary, not a new mechanism.

## Considered options

- **Keep one service, add a Redis ACL user only.** Cheaper, and it takes `FLUSHALL` and
  the rate-limit counters away from the notifier, but the internet-facing process would
  still sit on `data` with unauthenticated Kafka. Rejected: Kafka was the bigger hole.
- **One package, two entrypoints (same image, different `command`).** Less to build, no
  duplicated wire contract. Rejected: the internet-facing image would still ship kafkajs
  and the consumer code; separate apps keep its dependencies to what it runs.
- **Kafka SASL + ACLs instead of network isolation.** The right move for Kafka anyway, but
  it closes a different gap (who may use Kafka), not "the edge can reach the data
  network". Left for Phase 6.

## Consequences

- One more service. The wire contract (channel name + message shape) is duplicated in
  `apps/notifier/src/redis/publisher.ts` and `apps/sse-gateway/src/redis/subscriber.ts`, on
  purpose (a shared package couples deploys): change both.
- A compromised sse-gateway still receives every user's live events (one shared channel)
  and can reach lgtm (anonymous-admin Grafana). Per-user channels and an OTLP-only
  collector would close those.
- Redis is on the live-event path: Redis down → no SSE events; webhooks keep working
  (the publisher drops instead of throwing).
- The limited Redis clients can't run `INFO`, so ioredis's ready check is off for them.

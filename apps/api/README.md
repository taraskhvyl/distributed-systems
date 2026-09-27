# api

The public REST API (`https://api.localhost/v1`). Node 24 + TypeScript, Fastify 5.

It owns the metadata: who uploaded what, visibility, follows, likes, the feed. It never
touches file bytes. Browsers upload and download straight to S3 with presigned URLs the
api signs. Anything that must happen *after* a write (processing, notifications) leaves as
an event through the transactional outbox, never as a direct call.

## What it does

| endpoint | what |
|----------|------|
| `POST /files` | register an upload, return a presigned PUT URL (`Idempotency-Key` supported) |
| `POST /files/:id/complete` | check the object exists with the declared size, mark `uploaded`, emit `file.uploaded` |
| `GET /files`, `GET /files/:id` | own files; a Published file for anyone |
| `PATCH /files/:id` | change Visibility (`private` / `public`) |
| `POST /files/:id/download-url` | presigned GET (short TTL) |
| `DELETE /files/:id` | admin only |
| `PUT` / `DELETE /files/:id/like` | Like / unlike; a new Like emits `file.liked` |
| `PUT` / `DELETE /users/:username/follow` | Follow / unfollow |
| `GET /users`, `GET /users/:username` | search, profile |
| `GET /feed` | fan-out on read, keyset pagination |
| `GET /healthz`, `GET /readyz` | liveness; readiness checks Postgres and Redis |

`GET /v1/events` (live updates) is **not** here: Envoy routes it to `apps/sse-gateway`.

## Layout

```
src/
  main.ts            composition root: connect Kafka/Redis, start the outbox relay, listen
  config.ts          env → typed config (RATE_LIMIT_* knobs validated at startup)
  errors.ts          DomainError(code) → HTTP status in http/app.ts
  http/              Fastify app, auth hook (JWT), per-user write rate limit, shared schemas
  files/             routes → service → repository; access.ts = who may see what
  social/            follows, likes, feed (feed-cursor.ts = keyset cursor)
  users/             local read model of Keycloak users (ADR 0002)
  messaging/outbox.ts  insertOutboxEvent (same transaction) + the relay to Kafka
  adapters/          postgres, redis, kafka, s3: the only code that talks to them
```

Dependencies point one way: `routes → service → repository`, externals only via `adapters/`.

## Talks to

- **Postgres** (`api_user`): files, users, follows, likes, `outbox_events`.
- **Kafka**: the outbox relay publishes to `file-events` (key = fileId, so per-file order).
- **Redis**: the per-user write token bucket (Lua script; fails open if Redis is down).
- **S3 (SeaweedFS)**: signs URLs, `HEAD` on `complete`, deletes objects.
- **Keycloak**: only the JWKS, cached (`@mediashare/auth`); no call per request.

## Config (env)

`DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `WEB_ORIGIN`,
`S3_*`, optional `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL_PER_SECOND`. Set in
`compose/apps.yml`.

## Run

```bash
docker compose up -d --build api
API_REPLICAS=3 docker compose up -d api   # several replicas; each runs an outbox relay (SKIP LOCKED)
docker compose logs -f api
```

## Worth knowing

- JWTs are verified twice, at Envoy and here (ADR 0003).
- Each replica has its own pool (`max: 10`): N replicas = N × 10 Postgres connections.
- Outbox delivery is at-least-once: a crash between publish and `published_at` republishes.
- See `docs/ARCHITECTURE.md` (upload flow), `docs/DESIGN-DECISIONS.md` (outbox, feed, likes).

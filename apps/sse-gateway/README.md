# sse-gateway

Serves the browser's live-update stream: `GET https://api.localhost/v1/events`
(Server-Sent Events). Node 24 + TypeScript, plain `node:http`.

It is one of two internet-facing services (with the api), so it is deliberately small and
cut off from the data stores (ADR 0005):

- networks `edge` (Envoy, Keycloak JWKS) + `sse` (only Redis and lgtm): Kafka and Postgres
  don't even resolve from here;
- its Redis ACL user may run exactly `SUBSCRIBE sse-events`, nothing else;
- no Kafka client in the image.

## How an event reaches a tab

```
notifier ──PUBLISH sse-events──► Redis ──► every sse-gateway replica
                                              └─ holds a stream for that user? write the SSE frame
```

Every replica subscribes, so it doesn't matter which replica Envoy put a tab on
(measured 20 / 20 / 20 over 3 replicas).

## The stream

- Auth: `Authorization: Bearer <JWT>` checked at connect (`@mediashare/auth`). The browser
  uses `fetch()` streaming, not `EventSource`, because `EventSource` can't send headers.
- Closed at the token's `exp`, so a revoked user stops receiving within the token TTL.
- `: ping` every 25 s keeps proxies from dropping the idle connection.
- CORS for `WEB_ORIGIN`; Envoy passes the stream through unbuffered (`timeout: 0s`).
- A user receives only events whose owner is their `sub`.

## Layout

```
src/
  main.ts                  composition root: Redis subscriber + HTTP server + registry
  config.ts                env → config
  sse/events-server.ts     GET /v1/events, OPTIONS preflight, /healthz
  sse/stream-registry.ts   Registry: user id → open streams (in this process's memory)
  redis/subscriber.ts      SUBSCRIBE, decode (@mediashare/live-events), deliver locally
```

## Config (env)

`PORT` (3001), `AUTH_ISSUER`, `AUTH_JWKS_URL`, `WEB_ORIGIN`, `REDIS_URL` (with the
`sse-gateway` user).

## Run

```bash
docker compose up -d --build sse-gateway
docker compose up -d --scale sse-gateway=3 sse-gateway
.venv/bin/python tools/demo/sse_fanout.py          # 3 tabs × 20 likes, counts per tab
docker compose logs -f sse-gateway | grep "sse stream"
```

## Limits

- At-most-once: events while a tab is disconnected are not replayed.
- One channel for everyone: each replica receives every event, and a compromised gateway
  would see all users' events. Per-user channels would fix both.

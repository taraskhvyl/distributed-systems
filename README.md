# mediashare — a distributed media-sharing platform that runs on your laptop

A small but **complete** media-sharing platform built the way production systems are:
presigned S3 uploads, eventual consistency, the transactional outbox pattern, Kafka
consumer groups with retry/DLQ, OAuth2/OIDC, layered rate limiting, and network
segmentation — all running locally via Docker Compose.

```
                        ┌────────────────── mediashare-edge network ──────────────────┐
                        │                                                              │
  client ── HTTPS:443 ─▶│  gateway (nginx) ── auth.localhost ──▶ keycloak (OIDC, JWT)  │
  (demo/client.py)      │       │            ── api.localhost ──▶ api (Node+TS)       │
                        │       │            ── s3.localhost ───▶ storage (SeaweedFS) │
                        └───────┼──────────────────────────────────────────────────────┘
                                │ api also joins:
                        ┌───────┴───────────── mediashare-data network ────────────────┐
                        │  api ──▶ postgres ──▶ redis ──▶ kafka ◀── processor (Python) │
                        │                                          ◀── notifier (Node) │
                        │  storage (S3) ◀── api, processor                         │
                        └───────────────────────────────────────────────────────────┘
```

**Nothing but the gateway's port 443 is exposed to your host.** The gateway cannot even
reach the database, Kafka, or Redis — it only talks to `api`, `keycloak`, and `storage`.

## Quickstart

```bash
make up        # copies .env, generates TLS cert, builds, starts everything
make ps        # wait until everything is "healthy"
make demo      # runs the full end-to-end walkthrough (installs `requests` if needed)
```

Requirements: Docker + Docker Compose, Python 3. A wildcard self-signed certificate for
`*.localhost` is generated under `gateway/certs/` (macOS resolves `*.localhost` to
127.0.0.1 automatically; on Linux add the names to `/etc/hosts` if needed).

The demo client narrates 13 steps and asserts every behavior:

1. call the API without a token → 401
2. obtain an OIDC access token from Keycloak (JWT claims shown)
3. register file metadata → receive a **presigned S3 upload URL**
4. replay the same `Idempotency-Key` → the original file, no duplicate
5. upload bytes **directly to S3** through the gateway — no auth header, no API hop
6. confirm the upload → API writes an **outbox event** in the same transaction
7. poll status: `pending → uploaded → processing → ready` (**eventual consistency**)
8. compare sha256 of the processed file against the local file
9. download the original via a short-lived presigned URL; fetch the **public** thumbnail
10. upload an "infected" file → processor detects it, purges the object, status `infected`, downloads blocked (403)
11. burst 12 mutations → the per-user Redis token bucket returns 429s (client honors `Retry-After`)
12. RBAC: regular user's DELETE → 403; admin's DELETE → 204
13. list files

## Users (seeded in the Keycloak realm)

| user   | password   | realm roles   |
|--------|------------|---------------|
| demo   | demo-pass  | user          |
| admin  | admin-pass | user, admin   |

Keycloak admin console: `https://auth.localhost/admin` (user `admin`, password from
`KEYCLOAK_ADMIN_PASSWORD` in `.env`).

## The services

| service    | stack          | role                                                             |
|------------|----------------|------------------------------------------------------------------|
| gateway    | nginx          | TLS termination, host routing, per-IP rate limit, security headers |
| keycloak   | Keycloak 26    | OIDC identity provider, issues JWTs                              |
| api        | Node 20 + TS (Fastify) | public REST API: auth, presigned URLs, idempotency, outbox relay |
| processor  | Python 3.12    | Kafka consumer: malware scan, thumbnails, retry/DLQ, idempotent CAS claim |
| notifier   | Node 20 + TS   | second Kafka consumer group: user notifications / webhooks       |
| postgres   | Postgres 16    | file metadata + outbox table, least-privilege per-service roles  |
| kafka      | Kafka 3.9 (KRaft) | event backbone: `file-events`, `-retry`, `-dlq`              |
| storage    | SeaweedFS 4.47 | S3-compatible object store: private + public buckets, scoped IAM identities |
| redis      | Redis 7        | per-user token-bucket rate limiting (atomic Lua script)          |

## API surface (all behind `https://api.localhost`)

| method | path                        | auth        | notes                                    |
|--------|-----------------------------|-------------|------------------------------------------|
| GET    | `/healthz`, `/readyz`       | none        | liveness / readiness (checks pg + redis) |
| GET    | `/v1/files`                 | bearer JWT  | own files, `limit`/`offset`              |
| GET    | `/v1/files/:id`             | bearer JWT  | owner or admin (404 otherwise)           |
| POST   | `/v1/files`                 | bearer JWT  | optional `Idempotency-Key` header        |
| POST   | `/v1/files/:id/complete`    | bearer JWT  | verifies object exists + size matches    |
| POST   | `/v1/files/:id/download-url`| bearer JWT  | 5-minute presigned GET URL               |
| DELETE | `/v1/files/:id`             | role `admin`| purges objects + row                     |

## Exploring the running system

```bash
make logs                                                      # follow all services
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic file-events --from-beginning
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic file-events-dlq --from-beginning
docker compose exec postgres psql -U api_user -d mediashare \
  -c "SELECT id, filename, status FROM files ORDER BY created_at DESC;"
docker compose exec storage weed shell <<< "s3.bucket.list"
curl -k https://s3.localhost/media-thumbnails/<thumbKey>        # public bucket, no auth
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data flows, topics, state machine
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and every control, with trade-offs
- [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) — Q&A walkthrough of every design decision, mapped to concrete code paths
- [docs/ROADMAP.md](docs/ROADMAP.md) — learning roadmap: interactive UI → tracing → scaling → failure injection → advanced topics

## Teardown

```bash
make down      # stop (keeps data)
make reset     # stop + wipe volumes
```

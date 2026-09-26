# Architecture

## Bird's-eye view

Three tiers, two networks, one exposed port.

```
 Internet (your laptop)
    │  https://auth.localhost  → OIDC tokens
    │  https://api.localhost   → REST API
    │  https://s3.localhost    → S3 API (presigned uploads/downloads, public thumbnails)
    ▼
┌───────────────────────────── edge network ─────────────────────────────┐
│  gateway (nginx:443)   keycloak   api   storage(S3 gateway :8333)     │
└──────────────────────────────────┼─────────────────────────────────────┘
                          api also attaches to:
┌──────────────────────────────────▼─ data network ─────────────────────┐
│  postgres   redis   kafka   storage   api   processor   notifier      │
└───────────────────────────────────────────────────────────────────────┘
```

Network rules (enforced by Docker, mirroring VPC subnets + security groups):

| container  | edge | data | can be reached by              | can reach                       |
|------------|------|------|--------------------------------|---------------------------------|
| gateway    | ✔    | ✖    | internet (host :443 only)      | api, keycloak, storage          |
| keycloak   | ✔    | ✖    | gateway, api                   | (nothing it needs)              |
| api        | ✔    | ✔    | gateway (public), internal     | keycloak, postgres, redis, kafka, storage |
| storage    | ✔    | ✔    | gateway (S3 endpoint), internal| (nothing it needs)              |
| postgres   | ✖    | ✔    | api, processor                 | —                               |
| kafka      | ✖    | ✔    | api, processor, notifier       | —                               |
| redis      | ✖    | ✔    | api                            | —                               |
| processor  | ✖    | ✔    | internal only                  | postgres, kafka, storage        |
| notifier   | ✖    | ✔    | internal only                  | kafka, optional webhook egress  |

The gateway is *physically incapable* of reaching the database, Kafka, or Redis. Even if
nginx were fully compromised, data stores are unreachable from it. Workers (processor,
notifier) are not on the edge network at all — there is no route from the internet to them.

## The upload flow (the full sequence)

```
 client            gateway        api            postgres      kafka         processor        storage
   │                 │            │                │            │               │               │
   │── POST /realms/media/token ──┼────────────────┼────────────┼───────────────┼───────────────►keycloak
   │◄──────────── access token ───┼────────────────┼────────────┼───────────────┼───────────────┘
   │
   │── POST /v1/files {meta} ────►│── validate ───►│             │               │               │
   │                              │   JWT, insert  │ row status  │               │               │
   │                              │   'pending'    │ = pending    │               │               │
   │◄── {id, presigned PUT url} ──│                │             │               │               │
   │
   │── PUT bytes (presigned, no auth) ─────────────┼──────────────┼───────────────┼──────────────►│
   │◄── 200 ───────────────────────────────────────┼──────────────┼───────────────┼──────────────┘
   │
   │── POST /v1/files/:id/complete►│── HEAD obj ────┼──────────────┼───────────────┼──────────────►│
   │                              │  size check    │              │               │               │
   │                              │  TX: status=   │              │               │               │
   │                              │  'uploaded' +  │              │               │               │
   │                              │  outbox insert │              │               │               │
   │◄── 202 ──────────────────────│                │              │               │               │
   │                              │◄─ relay poll: SELECT ... FOR UPDATE SKIP LOCKED
   │                              │  publish file.uploaded ──────►│               │               │
   │                              │  mark published_at=now()      │               │               │
   │                              │                │              │── consume ───►│               │
   │                              │                │              │               │── claim() ───►│
   │                              │                │              │               │  status='processing'
   │                              │                │              │               │── GET obj ───►│
   │                              │                │              │               │── scan ──────│
   │                              │                │              │               │── PUT thumb ─►│
   │                              │                │◄─────────────│─ status='ready', checksum
   │                              │                │              │◄─ file.ready ─│               │
   │── GET /v1/files/:id ────────►│                │              │        (notifier consumes, logs notification)
   │◄── status: ready + thumbUrl ─│                │              │               │               │
```

## File state machine (eventual consistency)

```
            POST /v1/files                    complete + HEAD verified         processor claim()
 ┌──────┐ ─────────────────► ┌─────────┐ ─────────────────────────► ┌───────────┐
 │  –   │                    │ pending │                              │ uploaded  │
 └──────┘                    └─────────┘                              └───────────┘
                                        complete before upload: 409       │    │
                                        size mismatch: 409                │    │
                                                                       ▼    │ scan: EICAR
                                                                  ┌────────┐ │ delete object
                                                                  │processing│ │
                                                                  └────────┘ │
                                                                   │      │  ▼
                                              thumbnail + checksum │      │ 3 failed attempts
                                                                   ▼      ▼          ▼
                                                                ┌─────┐ ┌────────┐ ┌──────┐
                                                                │ready│ │infected│ │failed│
                                                                └─────┘ └────────┘ └──────┘
```

Clients observe this only by polling `GET /v1/files/:id` (the demo does this). In a product
you would add push (webhooks / WebSocket / SSE) — the notifier service is the natural place.

## Data model (postgres)

`files` — one row per upload: `id` (uuid), `owner_id` (JWT `sub`), metadata, `status`,
`object_key`, `thumbnail_key`, `checksum` (sha256, computed by the processor), optional
`idempotency_key` with a **partial unique index** `(owner_id, idempotency_key)`.

`outbox_events` — the transactional outbox: `event_id`, `aggregate_id` (fileId, used as the
Kafka message key), `event_type`, `payload` jsonb, `published_at` (null until relayed).

Roles: `api_user` (DML on both tables), `processor_user` (SELECT/UPDATE on `files` only).
DDL is owned by the init job, not by any service — services never create tables.

## Kafka topology

| topic             | partitions | retention | writers            | readers                        |
|-------------------|-----------|-----------|--------------------|--------------------------------|
| `file-events`     | 3         | default   | api relay, processor (emits result events) | processor, notifier |
| `file-events-retry`| 3        | default   | processor          | processor                      |
| `file-events-dlq` | 1         | 7 days    | processor          | (ops / inspection)             |

- Messages are keyed by `fileId` → **all events for one file land on the same partition**,
  so per-file ordering is guaranteed while different files process in parallel.
- Two **consumer groups** (`processor`, `notifier`) read the same topic independently —
  each has its own committed offsets. Notifier progress never blocks processing.
- Topics are provisioned by a `kafka-init` job before any consumer starts; auto-topic-creation
  is disabled (a broker that silently creates topics on typo is a production hazard).
- `KAFKA_NUM_PARTITIONS=3` is also the ceiling for processor parallelism: at most 3
  processor containers process concurrently per group — a concrete scaling lever to discuss.

## Event envelope

```json
{
  "eventId": "uuid",           // unique per publication, used for tracing
  "eventType": "file.uploaded",
  "aggregateId": "fileId",     // Kafka message key
  "occurredAt": "2026-09-24T07:51:49Z",
  "payload": { ... },
  "attempt": 0                 // only present on retry-topic messages
}
```

Event types: `file.uploaded` (api → pipeline), `file.ready` / `file.rejected` /
`file.failed` (processor → notifier).

## Why the outbox (the dual-write problem)

`complete` must change the DB *and* cause an event. If you `UPDATE` then `produce()`
and the producer call fails, the state change is stranded — no event, no processing,
file stuck in `uploaded`. If you produce first and the `UPDATE` fails, you process a
file the DB thinks is still `pending`. Either order has a failure window.

The outbox makes the event *part of the same transaction* as the state change: an
insert into `outbox_events`. A relay loop then publishes rows with
`published_at IS NULL` using `SELECT ... FOR UPDATE SKIP LOCKED` (safe with multiple
relay instances) and marks them published in the same DB transaction.

Delivery semantic is **at-least-once**: if the relay crashes between `produce()` and
`COMMIT`, the row rolls back and will be published again. Consumers therefore must be
idempotent — the processor's `claim()` is exactly that (see DESIGN-DECISIONS.md). Debezium/CDC
is the "industrial" version of this pattern (reading the WAL instead of polling a table).

## Component inventory (and its AWS mapping)

| here           | in a cloud deployment                              |
|----------------|-----------------------------------------------------|
| gateway        | ALB / API Gateway + WAF + CloudFront for the S3 host |
| keycloak       | Cognito user pool (or managed Keycloak)             |
| api            | ECS Fargate / EKS pods, autoscaled                  |
| processor      | ECS/K8s workers, one per partition (max 3)          |
| notifier       | ECS/K8s + SQS/SNS or webhook fan-out service        |
| storage        | S3 (presigned URLs work identically)                |
| kafka          | MSK                                                 |
| postgres       | RDS (per-service users, or separate DBs)            |
| redis          | ElastiCache                                         |

The services deliberately speak standard protocols only — the AWS SDK for S3, plain
Kafka/Postgres/Redis clients, OIDC for auth — so the swap from local services to managed
cloud ones is configuration, not code.

## Scaling notes

- **api** is stateless (JWT validation is local; no server-side session) → horizontal scale
  behind the gateway. First things to watch: postgres connection pool (`max: 10` per pod)
  and JWKS cache hit rate.
- **processor/notifier** scale to partition count, not beyond (3 here). More partitions =
  more parallelism, but per-file ordering only holds while the key-based mapping is stable.
- **storage** is a single `weed mini` node here — appropriate for a laptop; SeaweedFS scales
  by adding volume servers (see its docs) and S3 gateways are stateless behind a balancer.
- Hot objects (thumbnails) are the CDN story: public bucket + `Cache-Control` → served at
  the edge, presigned originals never cached.

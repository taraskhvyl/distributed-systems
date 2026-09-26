# Design decisions

Every answer below is grounded in code you can open and point at.

## The system in one paragraph

mediashare is a media-sharing platform: users upload files directly to S3-compatible
storage via presigned URLs, the API records metadata and emits events through a
transactional outbox to Kafka, and Python workers scan and thumbnail them with
retry/DLQ semantics. Auth is OIDC with locally-validated JWTs, there are two
rate-limiting layers, and the network is segmented so the gateway can't reach the data
stores. The whole system runs with one exposed port, and `make demo` walks through every
flow — including failure modes — live.

---

## Q: Why presigned URLs instead of uploading through the API?

**A:** Bytes through the API means every byte traverses the API twice (in + out to S3),
buffers in app memory, ties up event-loop workers, and multiplies bandwidth cost at
scale — the API becomes a bandwidth-bound proxy doing no useful work. With presigned
PUTs the API only does what it's for: authorization and metadata. The client uploads
straight to S3 through the same gateway host (`s3.localhost`), the URL is bound to one
method + one key + one expiry, and it's signed with credentials that only have
`Write` on that bucket (`docker-compose.yml`, storage identities; `services/api/src/s3.ts`).

Common follow-up questions:
- *"What's actually in the signature?"* — method, path (bucket+key), host, expiry,
  signed headers. Not the body (that's `UNSIGNED-PAYLOAD`) and not unsigned headers like
  Content-Type.
- *"Can a presigned URL be leaked and replayed?"* — yes, within its TTL and scope; that's
  why upload TTL is 10 min, download 5 min, and each URL is scoped to one object. For
  hostile clients you'd add one-time tokens or IP conditions.
- *"Large files?"* — multipart upload with presigned part URLs (same mechanism, more URLs);
  the API's 200 MB cap is the demo's policy choice.
- *"We hit this in production..."* — the AWS SDK checksum story (`BadDigest`,
  `requestChecksumCalculation: 'WHEN_REQUIRED'` in `services/api/src/s3.ts`) is a real
  production-grade anecdote that shows you've actually done this.

## Q: How do you keep the DB and Kafka consistent? (the dual-write problem)

**A:** You can't reliably do "UPDATE row, then publish" or the reverse — either order has
a crash window that strands one side. So `complete` commits *both* the state change and
an event row in one postgres transaction (`services/api/src/routes.ts`, `withTransaction`),
and a relay publishes rows where `published_at IS NULL`
(`services/api/src/outbox.ts`). That's the **transactional outbox pattern**.

Details worth knowing:
- The relay's read is `SELECT ... FOR UPDATE SKIP LOCKED` — multiple relay instances can
  run without double-publishing or lock contention.
- Delivery is **at-least-once**: crash after `produce()` but before `COMMIT` → the row
  stays unpublished → republished later. Hence consumers must be idempotent (next answer).
- The industrial version is CDC (Debezium tails the WAL) — same guarantee, lower
  latency, more moving parts. Polling a table at 250 ms is fine at this scale.

## Q: How do you handle duplicate events? (idempotency, three layers)

**A:** Duplicates are normal, not exceptional. Three layers:

1. **API idempotency key** — `POST /v1/files` accepts an `Idempotency-Key`; a partial
   unique index `(owner_id, idempotency_key)` + `ON CONFLICT DO NOTHING` makes retries
   return the original file instead of creating twins (`services/api/src/routes.ts`).
   The demo's step 4 replays the key and gets the same id back.
2. **Consumer claim (compare-and-set)** — the processor's first action is
   `UPDATE files SET status='processing' WHERE id=$1 AND status='uploaded'`
   (`services/processor/src/db.py`). If the rowcount is 0, someone else already claimed
   it — skip. This makes redelivery *and* concurrent workers safe with zero locks.
3. **Committed offsets only after success** — manual `consumer.commit(message=msg)` after
   each handled event (`services/processor/src/main.py`), so a crash re-delivers rather
   than loses.

## Q: Explain the Kafka setup.

**A:**
- Topics: `file-events` (3 partitions), `file-events-retry` (3), `file-events-dlq` (1,
  7-day retention). Provisioned by a `kafka-init` job with auto-create **disabled** —
  silent topic creation on a typo is a prod hazard.
- Messages are keyed by `fileId` → same partition → **per-file ordering** while different
  files process in parallel.
- Two **consumer groups** — `processor` and `notifier` — each with independent offsets:
  slow notifications can never stall processing (that's the point of groups vs a topic
  with multiple event types).
- Consumer parallelism is bounded by partition count: 3 partitions → at most 3 processor
  instances doing work. Want more throughput? Add partitions. That's the concrete scaling
  lever.
- KRaft mode (no ZooKeeper) — worth one sentence: metadata moved into the brokers
  themselves via Raft.

## Q: What happens when processing fails?

**A:** The processor catches, **releases the claim** (status back to `uploaded` so the
retry can re-claim), and republishes to `file-events-retry` with `attempt+1`. After 3
attempts it writes to the DLQ, marks the file `failed`, and emits `file.failed` (the
notifier would tell the user). Poison messages (bad JSON) are dropped with an error log
and the offset is committed — one bad event must not wedge a partition
(`services/processor/src/consumer.py`). There is a real dead-lettered event in the DLQ
from bring-up debugging — open it live:
`docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic file-events-dlq --from-beginning`.

**What if the worker dies mid-job** (`kill -9`, OOM)? `release()` never runs, and
Kafka redelivery alone doesn't help: the redelivered event hits a row that is still
`processing`, the CAS claim fails, the event is skipped, and its offset is committed.
So the claim is a **lease**. `updated_at` is stamped at claim time, and every 30 s each
processor runs a reaper that resets claims older than 120 s back to `uploaded` and
re-enqueues a `file.uploaded` on the retry topic (`reap_expired` in
`services/processor/src/db.py`). The reset is one atomic `UPDATE ... RETURNING`, so
concurrent reapers never double-enqueue. The cost is that a worker that is *slow* rather
than dead loses its lease and the job runs twice. That's harmless here because outputs
are deterministic, but a system with side effects would need fencing tokens.

Honest gap: the retry topic has no backoff delay — a proper version uses wait-planes
(topics with time-delayed consumption) or a scheduled retry.

## Q: Walk me through eventual consistency here.

**A:** The file row is the source of truth; S3 and derived artifacts converge to it.
`pending` (row exists, no bytes) → `uploaded` (bytes verified via HEAD + size check) →
`processing` (claimed) → `ready`/`infected`/`failed`. Clients poll `GET /v1/files/:id`
(the demo prints each transition). The `complete` endpoint is the sync/async boundary:
it *verifies* the upload synchronously (HEAD + declared-size match → 409 on mismatch)
before publishing. Push updates (webhooks/SSE) would slot into the notifier — it already
consumes `file.ready`.

If asked "why not make it synchronous?" — thumbnailing + scanning is CPU/IO work you
don't want in the request path; failures shouldn't fail the upload; and workers scale
independently of the API.

## Q: How does auth work? Why local JWT validation?

**A:** Keycloak issues 300 s RSA-signed JWTs. The API fetches the JWKS **once** (cached,
auto-refreshed on key rotation by `jose`) from the internal network and verifies
signature + `iss` + required claims **in-process** — zero extra round-trips per request
vs token introspection, which would make Keycloak a per-request dependency and a
bottleneck. Authorization is ownership (`owner_id` from the JWT `sub` — never client
input) plus realm roles for admin operations. One subtlety I can show: the JWKS URL is
internal (`http://keycloak:8080/...`) while the `iss` claim is the external
`https://auth.localhost/realms/media` — discovery vs validation are different concerns
(`services/api/src/auth.ts`, `services/api/src/config.ts`).

Related details: why 404 instead of 403 on other people's files (existence leak), why the
demo's password grant would be auth-code + PKCE in a browser, and why logout/revocation
is JWTs' weak spot (short TTL + refresh rotation is the standard answer).

## Q: How would you rate-limit this? 

**A:** Two layers, different keys, different failure domains: nginx per-IP (10 r/s,
dumb and early) and Redis per-user token bucket (capacity 5, 0.5/s refill) on mutating
routes only. The bucket math is one **Lua script** — atomic, so concurrent requests can't
both spend the last token (the naive GET/SET race). 429s carry `Retry-After`, and the
demo client honors it — rate limiting is a protocol between server and client, not just
a wall. Design trade-off: the Redis layer **fails open** if Redis dies (nginx
still holds the perimeter); strictness vs availability is a per-system decision.
Run `make demo` step 11: 3 accepted, 9 rate-limited.

## Q: Why is the network split in two?

**A:** Edge vs data — like public/private subnets. Only the gateway publishes a port;
it is *not* on the data network, so a compromised gateway has no route to Postgres,
Kafka, or Redis. Workers aren't on the edge at all — the internet cannot address them.
Presigned S3 traffic is the one deliberate exception: storage sits on both networks
because S3's public endpoint is authorized by signatures and bucket policy, not network
ACLs — exactly like real S3.

## Q: What happens if X dies? (pick any)

- **api** — gateway 502s; uploads in flight pause; no state lost (rows + objects are
  durable); restarts and resumes; the outbox relay catches up in one tick.
- **kafka** — `complete` still works (the event is safely in the outbox table);
  publishing pauses; the relay retries; consumers resume from committed offsets. Nothing
  is lost — the outbox is the buffer.
- **processor** — events pile up in Kafka (that's backpressure *working*), files sit in
  `uploaded`; new processor picks up from the committed offset.
- **postgres** — writes fail everywhere; healthchecks flip, `readyz` goes 503, the
  gateway keeps serving `/healthz`. This is the "you can't be consistent without your
  CP store" answer.
- **redis** — rate limiting fails open (logged); everything else works.
- **storage** — uploads/downloads fail; metadata is intact; SeaweedFS restarts with its
  volume. (Laptop-single-node — prod story is replication/erasure coding.)

Healthchecks with `depends_on: condition: service_healthy` and graceful SIGTERM
handlers (`services/api/src/server.ts`) are right there in the compose file.

## Q: How does this scale?

**A:** api is stateless → horizontal behind the gateway (watch pg pool sizes: `max: 10`
per instance). Processor scales to partition count (3), then add partitions. Postgres
read replicas for listing, partition the `outbox` by time if it grows, or move to CDC.
Thumbnails behind a CDN with `Cache-Control` (public bucket already) — originals are
presigned and never cached. Storage: SeaweedFS scales by adding volume servers; the S3
gateway is stateless behind the balancer. Resist the urge to shard the DB
immediately" — start with replicas + connection pooling.

## Q: Why SeaweedFS? (or: "why not MinIO?")

**A:** MinIO's community edition was archived in April 2026 — read-only repo, no
releases, no security patches — so building on it in 2026 means owning every future CVE.
SeaweedFS is Apache-2.0, actively maintained (12+ years), implements the S3 API including
presigned URLs, bucket policies, and IAM, and its one-binary `weed mini` mode is
explicitly supported for single-node S3-gateway/presigned-URL deployments. The
architecture decision that makes this swap cheap: **services only speak the S3 API via
the AWS SDK** — the storage backend is a config value, so "which S3 server" is an
operational choice, not an architectural one. (Bonus nuance: SeaweedFS bundles delete
into `Write:bucket`, unlike IAM's separate `s3:DeleteObject` — the processor's identity
is one notch broader than ideal, which I'd note in a threat review.)

## Q: What's missing / what would you do next?

Known limitations, tracked deliberately:

1. **Tracing** — logs are structured and correlated by `eventId`, but no OpenTelemetry
   spans; add it and the cross-service story becomes visual.
2. **Retry backoff** — the retry topic has no delay; real systems use time-partitioned
   retry topics or a scheduler.
3. **Keyset pagination** — listing uses OFFSET; fine here, keyset at scale.
4. **Outbox → CDC** — polling works; Debezium is the grown-up version.
5. **Push notifications** — polling is a demo choice; SSE/webhooks belong in the notifier.
6. **Multipart presigned uploads** for big files; per-user storage quotas (rate ≠ quota).
7. **Multi-region** — presigned URLs are region-agnostic but the metadata DB and Kafka
   are the hard part: that's a whole separate design discussion (CQRS + event replication +
   presigned against the closest region).
8. **Secrets** — `.env` is dev-grade; prod is Vault/Secrets Manager with rotation.
9. **The demo trusts `complete`'s HEAD check** — a belt-and-braces version would also
   consume S3-side notifications (bucket event → webhook) to catch un-confirmed uploads.

## AWS translation table (how this maps to a production deployment)

| local             | AWS                                                                    |
|-------------------|------------------------------------------------------------------------|
| gateway + TLS     | ALB + ACM certs, WAF, CloudFront in front of S3                        |
| keycloak          | Cognito (or Keycloak on ECS)                                           |
| api (Fastify)     | Fargate/EKS service, autoscaling on RPS                                |
| processor/notifier| Fargate/EKS workers (or SQS+SNS if you don't want Kafka's ops)         |
| storage           | S3 (identical presigned-URL code), SSE-KMS, lifecycle, object lock     |
| kafka             | MSK                                                                    |
| postgres          | RDS Multi-AZ, IAM auth, per-service users                              |
| redis             | ElastiCache                                                            |
| `.env` secrets    | Secrets Manager + rotation                                             |
| docker networks   | VPC, public/private subnets, security groups                           |
| compose healthchecks | ALB/target-group health checks + k8s probes                        |

## Quick reference

- Upload URL TTL 10 min; download 5 min; token TTL 300 s; bucket names
  `media-uploads` / `media-thumbnails`; consumer groups `processor` / `notifier`;
  rate limits 10 r/s per IP at nginx, 5-capacity/0.5 rps per user in Redis.
- The event envelope: `{eventId, eventType, aggregateId, occurredAt, payload, attempt}`.
- Infected marker: the EICAR test string — the processor deletes the object and marks
  `infected`; downloads then 403.
- Why KafkaJS + confluent-kafka can read the same topic: it's just the protocol —
  client library choice is per-team.

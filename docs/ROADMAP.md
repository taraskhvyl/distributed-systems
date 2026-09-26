# Learning roadmap

Goal: **interview readiness + real understanding** of distributed systems, using this repo.

**Definition of done for an experiment:** you ran it and saw the behavior yourself, **and**
a Q&A entry for it exists in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) that you could
explain out loud. Before each run, write a one-line prediction ("I expect…"). Being wrong
is where the learning happens.

Ground rules:
- Runtime is **Docker Compose** for Phases 1–4. Kubernetes appears only as an optional Phase 5 topic.
- Observability grows **with the experiments**: a metric is added in the phase whose experiment needs it.
- Schema changes: edit `db/init/02-schema.sql` + `make reset`. No migration tool until one is needed.
- Instrumentation speaks OTLP only; the backend is swappable.
- `make demo` must pass after every sub-phase. Every new endpoint gets a demo step.
- Domain terms (File, Published file, Feed, …) are defined in [CONTEXT.md](../CONTEXT.md).

Already done:
- [x] Processor claim is a lease; the reaper recovers work from crashed workers
  ([ADR-0001](adr/0001-processing-claims-are-leases.md))

---

## Phase 1 — Make it interactive

### 1a. Browser UI + live status

- [ ] `app.localhost`: a single static `index.html` + vanilla JS served by the gateway (no build step)
- [ ] Keycloak client `media-web` (public, standard flow); **hand-written PKCE** (WebCrypto), tokens in memory only, refresh before expiry
- [ ] **CORS** on the api and on SeaweedFS (the browser PUTs directly to presigned S3 URLs)
  - Prediction: what does the preflight for a presigned PUT look like, and which side rejects it first?
    _Api without CORS: preflight fails, the GET is never sent. Presigned PUT: SeaweedFS rejects the preflight._
- [ ] Upload from the browser with a progress bar
- [ ] `notifier` serves `GET /v1/events` (SSE) on the edge network; the gateway routes it; JWT verified at connect
- [ ] Client reads SSE via `fetch()` streaming + `Bearer` header (not `EventSource`); reconnect loop
- [ ] Server closes the stream at the token's `exp`; the client reconnects with a fresh token
- [ ] Document the notifier's edge exposure in `SECURITY.md`

Q&A entries: PKCE and why it exists; CORS preflight on presigned URLs; SSE auth options
(fetch vs ticket vs query-string); BFF as the production-hardening answer.

### 1b. Social features

- [ ] File **Visibility** (`private` default / `public`); non-owners can see and download **Published files** only
- [ ] Follow / unfollow (one-directional, no approval)
- [ ] Feed (**fan-out on read**: one SQL query over follows + published files)
- [ ] Likes: `likes (user_id, file_id)` PK, `like_count` updated in the same transaction, `file.liked` outbox event → SSE to the owner
- [ ] UI: feed, follow button, like button, live notifications

Q&A entries: fan-out on read vs write; idempotent likes.

## Phase 2 — Tracing

Follow one action through browser → gateway → api → outbox → Kafka → consumer → SSE as a single trace.

- [ ] Add `grafana/otel-lgtm` to compose (data network only)
- [ ] Auto-instrument api + notifier (Fastify, pg, ioredis, kafkajs); Python SDK in processor with spans around scan/thumbnail
- [ ] Propagate `traceparent` **across the outbox**: store it in an outbox column in the same transaction, relay sets it as a Kafka header, consumers continue the trace
  - Prediction: _
- [ ] Trace a like end to end: api → outbox → Kafka → notifier → SSE to the owner's browser
- [ ] `trace_id` in every log line (pino + `JsonFormatter`); jump trace → logs in Grafana
- [ ] nginx passes through `traceparent`

Key idea: auto-propagation breaks at async boundaries. Context must travel *with the data*.

## Phase 3 — Scaling (under load)

- [ ] **k6 script** replaying upload + feed + like flows; baseline on 1 replica. Where is the first bottleneck?
  - Prediction: _
- [ ] `--scale api=3`: bottleneck moves to the Postgres pool (3 × `max:10`). Confirm multiple outbox relays don't double-publish (`SKIP LOCKED`). PgBouncer as a Q&A entry only.
  - Prediction: _
- [ ] `--scale processor=4` on 3 partitions: one consumer sits idle. **Add consumer-lag metric.** Watch rebalances.
  - Prediction: _
- [ ] `--scale notifier=3`: SSE events go missing (the partition's consumer isn't the instance holding the connection). Fix with Redis pub/sub fan-out.
  - Prediction: _
- [ ] **Feed at scale**: seed thousands of follows; fan-out-on-read p99 blows up → fan-out on write (`feed-writer` consumer, Redis sorted set per user) → one user with 50k followers spikes lag → hybrid
  - Prediction: _
- [ ] **Hot key**: hammer likes on one viral file; row-lock contention caps throughput regardless of replicas → sharded counters → Redis `INCR` + periodic flush (exact vs approximate)
  - Prediction: _
- [ ] Increase to 6 partitions: key→partition remapping, effect on per-file ordering
  - Prediction: _
- [ ] Postgres read replica for GETs: replication lag, read-your-writes violation right after `complete`
  - Prediction: _
- [ ] 3 Kafka brokers, RF=3, `min.insync.replicas=2`, `acks=all`: durability vs. latency; kill the leader
  - Prediction: _

Key idea: fixing a bottleneck moves it. Parallelism is capped by partitions, not replicas.

## Phase 4 — Failure injection

Run in this order; each builds on the last.

- [ ] **Kafka down**: **add outbox-backlog metric**; backlog grows, then drains, nothing lost
  - Prediction: _
- [ ] **Poison pill**: a file that crashes the worker every time → `attempts` column → DLQ (closes the `ponytail:` in `consumer.py`)
  - Prediction: _
- [ ] **Network partition** (`docker network disconnect` one processor): a zombie worker finishes after its lease was reaped → double execution. Why a lease ≠ mutual exclusion; fencing tokens.
  - Prediction: _
- [ ] **Slow S3** (Toxiproxy latency): timeouts, retries with jitter, circuit breaker
  - Prediction: _
- [ ] **Retry backoff**: delayed retry topics (`retry-5s`, `retry-1m`) + DLQ replay tool
  - Prediction: _
- [ ] **Graceful shutdown**: redeploy during k6 with zero failed requests (including open SSE streams)
  - Prediction: _
- [ ] **Zero-downtime schema change** (expand/contract) during k6 across 2 api replicas
  - Prediction: _
- [ ] Verify only: Redis down → the rate limiter fails open (already documented)

Key idea: every guarantee has a failure mode; find it by breaking it on purpose.

## Phase 5 — Advanced topics (menu)

Pick in any order; suggested: d → a → e → c.

- [ ] **d) Per-user storage quotas**: consistent counters under concurrency (check-then-act races, reserve/commit)
- [ ] **a) CDC with Debezium** instead of outbox polling: compare latency and moving parts
- [ ] **e) Multi-region**: written design exercise only (what replicates, what's the source of truth)
- [ ] **c) KEDA on k8s** (kind/k3d): autoscale processors on consumer lag
- [ ] **f) Replace kafkajs** (unmaintained since 2023; logs `TimeoutNegativeWarning` on Node 24) with
  `@confluentinc/kafka-javascript` in the api relay and notifier

Out of scope: keyset pagination and multipart uploads. They're API design, not distributed systems.

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

- [x] `app.localhost`: a single static `index.html` + vanilla JS served by the gateway (no build step)
- [x] Keycloak client `media-web` (public, standard flow); **hand-written PKCE** (WebCrypto), tokens in memory only, refresh before expiry
- [x] **CORS** on the api and on SeaweedFS (the browser PUTs directly to presigned S3 URLs)
  - Prediction: what does the preflight for a presigned PUT look like, and which side rejects it first?
    _Api without CORS: preflight fails, the GET is never sent._ **Correct.**
    _Presigned PUT: SeaweedFS rejects the preflight._ **Wrong for SeaweedFS** (`-s3.allowedOrigins`
    defaults to `*`), **right for AWS S3** (no bucket CORS rule = every preflight rejected).
- [x] Upload from the browser with a progress bar
- [x] `notifier` serves `GET /v1/events` (SSE) on the edge network; the gateway routes it; JWT verified at connect
- [x] Client reads SSE via `fetch()` streaming + `Bearer` header (not `EventSource`); reconnect loop
- [x] Server closes the stream at the token's `exp`; the client reconnects with a fresh token
  - Prediction: _the stream closes at exp; the client refreshes the token and reconnects within a second._ **Correct:** opened with
    `closesInMs: 299899`, closed exactly 5 min later, reopened in the same second.
- [x] Document the notifier's edge exposure in `SECURITY.md`

Q&A entries: PKCE and why it exists; CORS preflight on presigned URLs; SSE auth options
(fetch vs ticket vs query-string); BFF as the production-hardening answer.

### 1b. Social features

- [x] File **Visibility** (`private` default / `public`); non-owners can see and download **Published files** only
- [x] Follow / unfollow (one-directional, no approval)
- [x] Feed (**fan-out on read**: one SQL query over follows + published files)
  - Prediction: _following 1000 users instead of 3 makes the feed slower._ **Correct**, and the plan changes too:
    3 follows = index lookups per author, 0.5 ms; 1000 follows = Seq Scan over all 20k Published files, 27 ms
    (`scripts/experiment-feed-plan.sh`).
- [x] Likes: `likes (user_id, file_id)` PK, `like_count` updated in the same transaction, `file.liked` outbox event → SSE to the owner
  - Prediction: _50 concurrent likes: atomic `like_count + 1` ends at 50, read-modify-write below 50._ **Correct:**
    50 vs 10, with 50 rows in `likes` either way (`scripts/experiment-like-race.sh`).
  - Prediction: _a like shows up in the owner's open tab instantly, no refresh._ **Correct for delivery:** the `file.liked` frame reached alice's stream
    0.25–0.43 s after the like (curl over HTTP/1.1 and HTTP/2, through the gateway). The browser toast was not confirmed; skipped.
- [ ] UI: feed, follow button, like button, live notifications (all built; live toast not confirmed in a browser)

Q&A entries: fan-out on read vs write; idempotent likes.

Follow-ups found in 1b (not scheduled):
- Private thumbnails via presigned GET, so unpublishing also revokes the thumbnail URL (SECURITY.md, "Thumbnails are capability URLs")
- Optional: type-check the web app with JSDoc + `// @ts-check` and `tsc --noEmit` (keeps "no build step")
- Optional frontend track: React + Vite + TS + Tailwind/shadcn rewrite of `web/` (drops "no build step"; bundle with the pnpm switch)

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
- [ ] **c) KEDA on k8s** (kind/k3d): autoscale processors on consumer lag; topics as Strimzi
  `KafkaTopic` resources (declarative, drift-corrected) instead of the `kafka-init` script
- [ ] **f) Replace kafkajs** (unmaintained since 2023; logs `TimeoutNegativeWarning` on Node 24) with
  `@confluentinc/kafka-javascript` in the api relay and notifier

Out of scope: multipart uploads (the feed already uses keyset pagination). They're API design, not distributed systems.

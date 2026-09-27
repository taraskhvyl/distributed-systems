# Learning roadmap

Goal: **interview readiness + real understanding** of distributed systems, using this repo.

**Definition of done for an experiment:** you ran it and saw the behavior yourself, **and**
a Q&A entry for it exists in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) that you could
explain out loud. Before each run, write a one-line prediction ("I expect…"). Being wrong
is where the learning happens.

Ground rules:
- Runtime is **Docker Compose** for Phases 1–4. Kubernetes appears only as an optional Phase 5 topic.
- Observability grows **with the experiments**: a metric is added in the phase whose experiment needs it.
- Schema changes: edit `infra/postgres/init/02-schema.sql` + `make reset`. No migration tool until one is needed.
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
    (`tools/scripts/experiment-feed-plan.sh`).
- [x] Likes: `likes (user_id, file_id)` PK, `like_count` updated in the same transaction, `file.liked` outbox event → SSE to the owner
  - Prediction: _50 concurrent likes: atomic `like_count + 1` ends at 50, read-modify-write below 50._ **Correct:**
    50 vs 10, with 50 rows in `likes` either way (`tools/scripts/experiment-like-race.sh`).
  - Prediction: _a like shows up in the owner's open tab instantly, no refresh._ **Correct for delivery:** the `file.liked` frame reached alice's stream
    0.25–0.43 s after the like (curl over HTTP/1.1 and HTTP/2, through the gateway). The browser toast was not confirmed; skipped.
- [x] UI: feed, follow button, like button, live notifications (toast confirmed side by side in two browser windows)

Q&A entries: fan-out on read vs write; idempotent likes.

Follow-ups found in 1b (not scheduled):
- Private thumbnails via presigned GET, so unpublishing also revokes the thumbnail URL (SECURITY.md, "Thumbnails are capability URLs")
- Optional: type-check the web app with JSDoc + `// @ts-check` and `tsc --noEmit` (keeps "no build step")
- Optional frontend track: React + Vite + TS + Tailwind/shadcn rewrite of `apps/web/` (drops "no build step"; bundle with the pnpm switch)

## Phase 2 — Tracing

Follow one action through browser → gateway → api → outbox → Kafka → consumer → SSE as a single trace.

Ticked on run + recorded outcome; Q&A entries skipped for this phase by choice (the "why"
lives in ARCHITECTURE "Tracing" and SECURITY "Trace context from clients").

- [x] Add `grafana/otel-lgtm` to compose (data network only); Grafana on 127.0.0.1:3000
- [x] Auto-instrument api + notifier (http, pg, ioredis, kafkajs, pino; `@fastify/otel` since
  the fastify instrumentation was removed); Python zero-code in processor with spans around scan/thumbnail
  - Processor: the confluent-kafka instrumentation only *links* a consumed message to its
    producer, so `kafka_loop.py` extracts `traceparent` and continues the trace. Upload → processor
    → notifier is now one trace.
- [x] Propagate `traceparent` **across the outbox**: store it in an outbox column in the same transaction, relay sets it as a Kafka header, consumers continue the trace
  - Prediction (before, plain auto-instrumentation): one trace, "the Kafka instrumentation passes it along".
  - Outcome: **two traces**. Trace 1 = `PUT /v1/files/:id/like` → pg queries → `COMMIT` (the
    outbox INSERT is in it), then nothing. Trace 2 is rooted at the relay's `send file-events`
    and continues into the notifier's `process file-events`. Kafka itself propagated fine
    (kafkajs header); the break is the outbox: the relay's timer has no request context.
    Side finding: every 250 ms relay tick made 4 orphan root traces (BEGIN/SELECT/COMMIT/connect).
  - Fix: `traceparent` column + `outbox publish` span under it → one trace; the gap before it
    is the outbox delay (~230 ms). Poll runs under `suppressTracing`: idle ticks → 0 traces.
- [x] Trace a like end to end: api → outbox → Kafka → notifier → SSE to the owner's browser
  - Server side done: trace ends in `sse.publish` (`sse.open_streams`), frame carries `traceId`.
  - Outcome: demo liked alice's file in the browser; alice's console logged
    `[trace] received file.liked traceId=621fe170…`, the same id as the `PUT` in Tempo.
    Timeline: handler +6 ms, `outbox publish` +173 ms (relay poll wait), notifier
    `sse.publish` +239 ms. Tempo shows "root span not yet received": the browser sends
    `traceparent` but exports no spans of its own (would need a public OTLP endpoint).
  - Toast: confirmed side by side (alice + demo in incognito). It was easy to miss, so it
    moved top-right in the accent colour and stays 8 s.
- [x] `trace_id` in every log line (pino + `JsonFormatter`); jump trace → logs in Grafana
  - `trace_id` done in all three services.
  - Outcome: "Related logs" on the `PUT` span shows the api's log lines only. The lgtm
    provisioning scopes the query to the clicked span's service:
    `{service_name="<span service>"} | trace_id = "<id>"`. All services at once:
    `{service_name=~".+"} | trace_id = "<id>"` in Explore → Loki.
- [x] nginx passes through `traceparent`
  - Browser starts the trace (`apps/web/js/trace.js`). Prediction (sending it without a CORS change): like fails.
  - Outcome: correct. The preflight still returns 204, but `Access-Control-Allow-Headers` lacks
    `traceparent`, so the browser drops the real request ("Failed to fetch") and the api logs
    nothing. After adding it: a hand-made `traceparent` sent through the gateway came back in
    Tempo under the same trace id, api root span parented to the sent span id. nginx passes it untouched.

Key idea: auto-propagation breaks at async boundaries. Context must travel *with the data*.

Experiments:
- [x] Stop the notifier ~30 s, like, start it again.
  - Prediction: _one trace; alice gets the toast after the restart._ **1 correct, 2 wrong.**
  - Outcome: one trace with a 36.5 s gap between `send file-events` and `process file-events`
    (the notifier's consumer lag); the processor (own group) handled it at +0.2 s. The
    notifier resumed from its committed offset and pushed the event 60 ms after start, but
    `sse.publish` had `open_streams = 0`: alice's reconnect backoff (1→30 s, jittered,
    `apps/web/js/live-events.js`) brought her back 26 s later. No toast; the like count was right
    (resync on reconnect). Kafka → notifier is at-least-once, notifier → browser at-most-once.
    Fix if needed: a durable notifications inbox fetched on reconnect (+ `Last-Event-ID`).
- [x] A processor failure → retry topic: does the retry continue the same trace?
  - Setup: pause processor, `complete`, stop storage, unpause; storage back after ~34 s.
  - Prediction: _separate traces; the file becomes ready once storage is back._ **Both wrong.**
  - Outcome: **one trace** (`complete` → 3× `handle file.uploaded` → `file-events-dlq send`
    → `handle file.failed`): the retry is produced inside the `handle` span, so its Kafka
    header carries the context. The file ended **failed in the DLQ** after 13 s, while storage
    was down 34 s: retries have no delay, so a transient outage burns all attempts (each
    ~4.5 s only from botocore's own connect retries). Nothing recovers it afterwards.
    → Phase 4 "Retry backoff" (delayed retry topics + DLQ replay).

Follow-ups found in 2 (not scheduled):
- Each consumed message still leaves a tiny orphan `recv` trace from the processor's
  auto-instrumentation (it links, we parent). Filter or disable if it gets noisy.
- The processor's claim reaper queries run outside any span (periodic orphan traces).
- Processor: an *unexpected* exception is logged and its offset still committed
  (`kafka_loop.py`, `except Exception`), so that class of errors is at-most-once. Phase 4 poison pill.
- Dashboards: none yet on purpose (Explore covers single traces). First one comes with the
  Phase 3 consumer-lag metric.

## Phase 3 — Scaling (under load)

- [ ] **k6 script** replaying upload + feed + like flows; baseline on 1 replica. Where is the first bottleneck?
  - Prediction: _the api's Postgres pool (`max: 10`)._
  - Run 1 (`make loadtest`, 20 VUs, 2 users, one IP): **wrong, never reached Postgres.**
    61% of 1,987 requests got 429: nginx per-IP 995, Redis per-user bucket 214. Pool at most
    5/10 connections, all idle; api CPU ≤ 25%; successful p95 24 ms. A single-source test
    measures the throttles, not capacity.
    Side find: Fastify's own 4xx (empty JSON body) were answered 500; fixed.
  - Run 2 (after the gateway swap below, so it measures the new edge): load generator
    exempt from per-IP limits, 50 test users (`setup()` creates them). Prediction: _
- [ ] **Swap the gateway: nginx → Envoy.** Question: what does a real API gateway add over a
  reverse proxy, and what does it cost?
  - Parity first (`make demo` must pass): TLS, host routing (app/api/auth/s3), SSE without
    buffering and with long timeouts, security headers/CSP, `traceparent` passthrough.
    Envoy doesn't serve files: `apps/web` needs a small static server behind it.
  - Per-IP limit: Envoy's `local_ratelimit` is one bucket per route, not per client. Per-IP
    (and the load-generator exemption) needs the global rate-limit service
    (`envoyproxy/ratelimit` + Redis): local vs global limiting.
  - Then the gateway features: `jwt_authn` validates Keycloak JWTs at the edge (bad tokens
    never reach a service); per-user limit keyed on the JWT `sub` at the edge; timeouts,
    retries, outlier detection per upstream; Envoy emits its own spans (the edge shows up in
    Tempo).
  - ADR: keep JWT checks in the services too (defense in depth) or trust the edge?
  - Prediction: _
- [ ] `--scale api=3`: bottleneck moves to the Postgres pool (3 × `max:10`). Confirm multiple outbox relays don't double-publish (`SKIP LOCKED`). PgBouncer as a Q&A entry only.
  - Prediction: _
- [ ] `--scale processor=4` on 3 partitions: one consumer sits idle. **Add consumer-lag metric** (first Grafana dashboard). Watch rebalances.
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
- [ ] **Poison pill**: a file that crashes the worker every time → `attempts` column → DLQ (closes the `ponytail:` in `pipeline/handler.py`)
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

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
- [x] Frontend track: React + Vite + TS + Tailwind/shadcn rewrite of `apps/web/`, Instagram
  layout (ADR 0004). Found on the way: the CSP silently dropped the `<style>` tags Radix
  and sonner inject (unstyled toasts, no scroll lock) → `style-src 'self' 'unsafe-inline'`;
  shadcn's CLI pulled in an unrelated npm package `cn` (replaced by a local helper).

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

- [x] **k6 script** replaying upload + feed + like flows; baseline on 1 replica. Where is the first bottleneck?
  - Prediction: _the api's Postgres pool (`max: 10`)._
  - Run 1 (`make loadtest`, 20 VUs, 2 users, one IP): **wrong, never reached Postgres.**
    61% of 1,987 requests got 429: nginx per-IP 995, Redis per-user bucket 214. Pool at most
    5/10 connections, all idle; api CPU ≤ 25%; successful p95 24 ms. A single-source test
    measures the throttles, not capacity.
    Side find: Fastify's own 4xx (empty JSON body) were answered 500; fixed.
  - Run 2 (after the gateway swap below, so it measures the new edge): load generator
    exempt from per-IP limits, 50 test users (`setup()` creates them). Prediction: _Keycloak._
    **Wrong — Keycloak isn't on the request path at all.** 2,378 requests, 22/s: the only
    Keycloak traffic during the run was one open browser tab's 5-min token refresh (tokens
    are prefetched in `setup()`; both JWT checks verify against cached JWKS — local validation
    keeps the IdP off the hot path by design). The first thing to give was a throttle again,
    this time the api's own write bucket (5 burst, 0.5/s refill): 190 429s (8%), all on
    writes — a like iteration spends 2 tokens/s per user (PUT + DELETE), 4× the refill;
    like 21% rejected, upload_complete 30%. Zero from the edge: per-IP exempt, and the
    10/s per-`sub` window was never close (≤2 req/s per user). Nothing else was loaded:
    feed p95 18.7 ms, pool 2/10, 0 5xx. A virtual user writes faster than a human, so
    policy saturates before capacity.
  - Run 3 (policy off, capacity on): the write bucket → 1,000,000 via the new
    `RATE_LIMIT_*` env knobs; edge per-user 10/s → 100,000/s in
    `infra/ratelimit/config.yaml` (both reverted after). Climb VUs until a *resource* gives.
    Prediction: _the api's Postgres pool (`max: 10`)_ — Run 1's, still untested.
    **Confirmed at 200 VUs, with a twist: the pool is the cap, but *writes* fill it.**
    100 VUs (98 req/s): 0 errors, p95 275 ms — a tail already, on the write path.
    200 VUs (162 req/s): median 110 ms, p95 0.9 s, still **0 failed requests** —
    saturation is queueing, not errors. Pool pinned 10/10; `pg_stat_activity` showed the
    mechanism: 5 sessions `Lock/tuple` + 1 `Lock/transactionid` (every VU likes the *same*
    file → `UPDATE files` serializes on one row), 1 `IO/WalSync` (each like holds its
    connection through a fsync-bound COMMIT). Feeds slowed as innocent bystanders queued
    behind write txns. Api-side `responseTime` p95 ≈ k6's p95 → the queue is inside the api;
    Envoy/ratelimit (11% CPU) exonerated. Postgres CPU 31%: the pool caps *concurrency*,
    not db capacity. The "Hot key" item below showed up early — it filled the pool before
    its own experiment. Where the bottleneck moves next: `API_REPLICAS=3` (3 × 10 conns,
    the hot row stays until sharded counters).
- [ ] **Swap the gateway: nginx → Envoy.** Question: what does a real API gateway add over a
  reverse proxy, and what does it cost?
  - [x] Parity (`make demo` passes): TLS + HTTP/2, host routing (app/api/auth/s3), SSE
    streamed with `timeout: 0s`, security headers/CSP, `traceparent` passthrough. `apps/web`
    is served by a stock nginx `web` container (Envoy doesn't serve files).
  - [x] Per-IP limit via the global rate-limit service (`envoyproxy/ratelimit` + Redis):
    Envoy's `local_ratelimit` is one bucket per route, not per client. Fixed one-second
    windows (no burst); the loadtest /24 is `unlimited` via a `masked_remote_address`
    descriptor. Finding: per-IP and per-user limits now fail open on the **same Redis**
    (with nginx they were separate failure domains). Backstop to add: `local_ratelimit`.
    Side find: the k6 smoke run made 50 users follow alice and broke `make demo`'s exact
    assertions; the load test now uses its own author (`loadtest-01`).
  - Then the gateway features: `jwt_authn` validates Keycloak JWTs at the edge (bad tokens
    never reach a service); per-user limit keyed on the JWT `sub` at the edge; timeouts,
    retries, outlier detection per upstream; Envoy emits its own spans (the edge shows up in
    Tempo).
  - [x] ADR: keep JWT checks in the services too (defense in depth) or trust the edge?
    → both (`docs/adr/0003-jwt-verified-at-edge-and-in-services.md`).
  - Prediction: _a bad token gets its 401 from Envoy and the api sees nothing; valid
    requests get slower (the token is checked at the edge and again in the service)._
  - [x] `jwt_authn` on the api host (incl. `/v1/events`), JWKS from `keycloak:8080` cached
    10 min, `bypass_cors_preflight`, `forward: true` (services still verify). Outcome: first
    half **confirmed**: bad/missing tokens get 401 with `upstream: null` and a reason in the
    new `details` log field (`jwt_authn_access_denied{Jwt_is_missing}`); the api logged 0 of
    them. Second half **refuted**: 140 keep-alive GETs, on vs off, p50 13.8 vs 14.1–15.4 ms,
    inside noise. An RS256 check against a cached key is microseconds; the cost of JWT auth
    is fetching keys, not verifying. Side find: the edge's 401 has **no CORS headers**, so the
    browser sees "Failed to fetch" instead of a readable 401 (the api's own 401 had them).
    Fixed at the class level: the api host adds CORS headers `ADD_IF_ABSENT`, so every reply
    Envoy makes itself (401, 429) is readable and the services stay the owners of CORS.
  - [x] Per-user limit on the JWT `sub` at the edge. Prediction: _the 429 comes from the
    edge, and the api's Redis token bucket is no longer needed._ Design chosen: the edge
    limits *all* requests per `sub` (10/s), the api keeps its *write* bucket (5 burst, 0.5/s)
    — `envoyproxy/ratelimit` only has fixed windows, no token bucket, no `Retry-After`.
    Outcome: **partly refuted** — which layer answers depends on which limit is tighter, not
    on which is first. Bursts as alice: 15 GETs → 10 ok, 5 × 429 from the edge; 8 writes →
    5 ok, 3 × 429 from the api; 15 writes → 5 ok, 5 edge + 5 api. The api bucket stays:
    it's the only write limit, and it holds for callers that bypass Envoy (ADR 0003).
    Two stages needed: per-IP before `jwt_authn`, per-user after (it reads `sub` from
    `payload_in_metadata`). Edge 429s had no `Retry-After`; `local_reply_config` adds `1`.
- [ ] `--scale api=3`: bottleneck moves to the Postgres pool (3 × `max:10`). Confirm multiple outbox relays don't double-publish (`SKIP LOCKED`). PgBouncer as a Q&A entry only.
  - Now a knob: `API_REPLICAS` (default 1, `compose/apps.yml`). Prediction: skipped.
  - [x] 3 replicas, `make demo`: Envoy (STRICT_DNS) round-robins, 14 / 14 / 15 api requests
    per replica. Outbox: 4 events, each exactly once in `file-events`, spread over the
    relays (1 / 2 / 1). Small sample; the load run is still open.
  - [ ] Under load (k6): where does the bottleneck move? Kill a replica mid-publish (at-least-once).
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

## Phase 6 — Deploy to a server

One VPS with Docker Compose (8 GB RAM: Kafka + Keycloak + lgtm take ~3–4 GB). Question: what
in a "works on my laptop" stack is really configuration, and what is hidden dev-only state?

- [ ] **Domain as one variable**: `DOMAIN` replaces the hardcoded `*.localhost` (~12 config
  files). Envoy can't read env, so `envoy.yaml` is rendered from a template (`envsubst`); the
  web app gets its URLs at build time (`VITE_*`). Removes the "change both" comments.
- [ ] **Keycloak in production mode**: `start` instead of `start-dev`, data in Postgres (today
  it's lost when the container is recreated), no seeded users with known passwords.
- [ ] **Real TLS**: Let's Encrypt (certbot + gateway reload, or a wildcard via DNS challenge);
  Envoy has no ACME client. Port 80 only for the challenge and the HTTPS redirect.
- [ ] **Secrets and access**: fresh `.env` values; Grafana and kafka-ui stay on loopback,
  reached through an SSH tunnel.
- [ ] **Backups**: `pg_dump` + the `weeddata` volume on a schedule; one restore drill.
- [ ] **Deploy path**: `git pull && make up` first; then images built in GitHub Actions and
  pulled from a registry (the server stops compiling).

Out of scope: Kubernetes and managed services (MSK, RDS, S3). Phase 5c covers k8s locally.

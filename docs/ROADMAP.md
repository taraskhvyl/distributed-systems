# Learning roadmap

Goal: **interview readiness + real understanding** of distributed systems, using this repo.

**Definition of done for an experiment:** you ran it and saw the behavior yourself, **and**
a Q&A entry for it exists in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) that you could
explain out loud. Before each run, write a one-line prediction ("I expect…"). Being wrong
is where the learning happens.

Ground rules:
- Runtime is **Docker Compose** for Phases 1–3. Kubernetes appears only as an optional Phase 4 topic.
- Observability grows **with the experiments**: a metric is added in the phase whose experiment needs it.
- Schema changes: edit `db/init/02-schema.sql` + `make reset`. No migration tool until one is needed.
- Instrumentation speaks OTLP only; the backend is swappable.

Already done:
- [x] Processor claim is a lease; the reaper recovers work from crashed workers
  (`services/processor/src/db.py` `reap_expired`)

---

## Phase 1 — Tracing

Follow one upload through gateway → api → outbox → Kafka → processor → notifier as a single trace.

- [ ] Add `grafana/otel-lgtm` to compose (data network only)
- [ ] Auto-instrument api + notifier (Fastify, pg, ioredis, kafkajs); Python SDK in processor with spans around scan/thumbnail
- [ ] Propagate `traceparent` **across the outbox**: store it in an outbox column in the same transaction, relay sets it as a Kafka header, consumers continue the trace
  - Prediction: _
- [ ] `trace_id` in every log line (pino + `JsonFormatter`); jump trace → logs in Grafana
- [ ] nginx passes through `traceparent`

Key idea: auto-propagation breaks at async boundaries. Context must travel *with the data*.

## Phase 2 — Scaling (under load)

- [ ] **k6 script** replaying the demo flow; baseline on 1 replica. Where is the first bottleneck?
  - Prediction: _
- [ ] `--scale api=3`: bottleneck moves to the Postgres pool (3 × `max:10`). Confirm multiple outbox relays don't double-publish (`SKIP LOCKED`). PgBouncer as a Q&A entry only.
  - Prediction: _
- [ ] `--scale processor=4` on 3 partitions: one consumer sits idle. **Add consumer-lag metric.** Watch rebalances.
  - Prediction: _
- [ ] Increase to 6 partitions: key→partition remapping, effect on per-file ordering
  - Prediction: _
- [ ] Postgres read replica for GETs: replication lag, read-your-writes violation right after `complete`
  - Prediction: _
- [ ] 3 Kafka brokers, RF=3, `min.insync.replicas=2`, `acks=all`: durability vs. latency; kill the leader
  - Prediction: _

Key idea: fixing a bottleneck moves it. Parallelism is capped by partitions, not replicas.

## Phase 3 — Failure injection

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
- [ ] **Graceful shutdown**: redeploy during k6 with zero failed requests
  - Prediction: _
- [ ] **Zero-downtime schema change** (expand/contract) during k6 across 2 api replicas
  - Prediction: _
- [ ] Verify only: Redis down → the rate limiter fails open (already documented)

Key idea: every guarantee has a failure mode; find it by breaking it on purpose.

## Phase 4 — Advanced topics (menu)

Pick in any order; suggested: d → b → a → e → c.

- [ ] **d) Per-user storage quotas**: consistent counters under concurrency (check-then-act races, reserve/commit)
- [ ] **b) Push notifications (SSE) across N notifiers**: route to the instance holding the connection (Redis pub/sub)
- [ ] **a) CDC with Debezium** instead of outbox polling: compare latency and moving parts
- [ ] **e) Multi-region**: written design exercise only (what replicates, what's the source of truth)
- [ ] **c) KEDA on k8s** (kind/k3d): autoscale processors on consumer lag

Out of scope: keyset pagination and multipart uploads. They're API design, not distributed systems.

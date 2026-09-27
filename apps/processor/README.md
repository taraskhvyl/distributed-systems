# processor

The worker that turns an uploaded file into a usable one. Python 3.14, a Kafka consumer in
the consumer group `processor`.

For every `file.uploaded` event it claims the file, downloads it from S3, scans it, computes
a checksum, makes a thumbnail, and marks the file `ready` (or `infected` / `failed`). It is
not reachable from the internet at all: `data` network only, no HTTP server.

## Flow

```
file-events / file-events-retry
  → claim (CAS: uploaded → processing)    duplicate delivery? rowcount 0 → skip
  → S3 GET → scan (EICAR test marker) → sha256 → thumbnail (Pillow, WebP) → S3 PUT
  → status ready  + emit file.ready
     infected     + upload deleted from S3 + emit file.rejected
  on error: retry topic (attempt + 1), after max_attempts → DLQ + status failed + file.failed
```

## Layout

```
src/
  main.py          composition root: build the parts, subscribe, run the loop
  config.py        env → Config (max_attempts, lease and reaper intervals)
  kafka_loop.py    poll → handle → commit (one message at a time), rebalance logging, reaper tick
  pipeline/        handler.py (what happens to one event), scan.py, thumbnail.py
  adapters/        db.py (claim, release, reaper), s3.py, events.py (emit, retry, DLQ)
  log.py           JSON logs with trace ids
```

## Guarantees

- **At-least-once**: the offset is committed only after the event was handled (or moved to
  retry/DLQ). A crash redelivers; the claim absorbs the duplicate.
- **Claim = Lease** (ADR 0001): a worker that dies mid-job leaves the file `processing`;
  the reaper resets claims older than 120 s so the work is retried.
- Parallelism is bounded by partitions (3): a 4th replica sits idle as a hot standby.

## Talks to

- **Kafka**: consumes `file-events` + `file-events-retry`; produces results to `file-events`,
  retries to `file-events-retry`, poison to `file-events-dlq`.
- **Postgres** (`processor_user`): only `SELECT, UPDATE` on `files`. It cannot write the outbox.
- **S3**: reads uploads, writes thumbnails (its own S3 identity).

## Config (env)

`DATABASE_URL`, `KAFKA_BROKERS`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, optional
bucket and topic names. Set in `compose/apps.yml`.

## Run

```bash
docker compose up -d --build processor
docker compose up -d --scale processor=4 processor    # watch rebalances in the logs
docker compose logs -f processor | grep -E "partitions|event handled"
```

## Known gaps

- No SIGTERM handler: a planned stop behaves like a crash (roadmap Phase 4).
- Retries have no delay; unexpected exceptions are committed (at-most-once for that class).

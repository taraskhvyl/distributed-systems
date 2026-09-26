# AGENTS.md

This is a **learning repo** for distributed systems. The user is here to understand how
things are built, not just to get working code.

## Teaching rule (always)

Whenever you add, change, or remove something, explain it to the user in your reply:
- **What** changed (files and the concept, e.g. "added a lease to the processor claim").
- **Why**: the distributed-systems problem it solves, and what fails without it.
- **Trade-off**: what it costs or what it still doesn't cover.
- **How to see it**: a command or experiment that shows the behavior live.

Keep it short and concrete. Point at `file:line`, and don't lecture.
When a change affects a documented design decision, update `docs/DESIGN-DECISIONS.md` too.

## Commands

```bash
make up      # .env + TLS certs + build + start (only gateway :443 is exposed)
make ps      # wait until everything is healthy
make demo    # end-to-end walkthrough (demo/client.py); this is the main test
make logs    # follow all services
make down    # stop, keep data
make reset   # stop + wipe volumes (needed after editing db/init/*)
docker compose up -d --build <service>   # rebuild one service after a code change
docker compose exec postgres psql -U api_user -d mediashare
```

There is no unit test suite. `make demo` asserts every flow.

## Architecture

- `services/api`: Node 20 + TS (Fastify). Auth (Keycloak JWT), presigned S3 URLs,
  idempotency keys, transactional outbox relay (`src/outbox.ts`).
- `services/processor`: Python 3.12 Kafka consumer. Scan + thumbnail, CAS claim, retry/DLQ,
  expired-claim reaper (`src/consumer.py`, `src/db.py`).
- `services/notifier`: Node consumer, separate consumer group.
- `gateway/nginx.conf`: TLS, host routing, per-IP rate limit.
- `db/init/`: schema and roles. **Runs only on a fresh volume.** Schema changes need
  `make reset` (or a manual `ALTER` on a running db).
- Kafka topics: `file-events` (3 partitions), `file-events-retry`, `file-events-dlq`.
  Auto-create is off; topics are made by `kafka-init` in `docker-compose.yml`.

## Gotchas

- Delivery is at-least-once everywhere. Every consumer must stay idempotent.
- The processor DB role only has `SELECT, UPDATE` on `files`. It cannot write the outbox.
- Networks: the gateway is on `edge` only and cannot reach postgres/kafka/redis. Keep it that way.
- Docs live in `docs/` (ARCHITECTURE, SECURITY, DESIGN-DECISIONS). Keep them in sync with the code.

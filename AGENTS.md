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

## Code principles (always)

This code is read to learn from, so **readability beats brevity**. When a "shortest diff"
habit conflicts with these rules, these rules win.

- **KISS.** The simplest design that meets today's requirement. No speculative
  abstractions or config for values that never change. Simple ≠ terse: prefer a few clear
  lines over one clever line.
- **DRY.** One source of truth for each piece of logic and config:
  - Logic used in two places gets extracted and named, not copy-pasted.
  - Repeated values (origins, issuer URLs, topic names) are defined once
    (a config module, a compose `x-` anchor, env) and referenced.
  - If duplication across services is deliberate (shared libs couple deploys), say so in
    a comment at both sites.
- **Single responsibility.** One module = one job. Keep transport (HTTP/SSE routing),
  auth, domain logic, messaging, and UI rendering in separate modules/functions.
- **Patterns where the problem has that shape.** Use a known pattern and name it in a
  one-line comment when it fits, e.g. a *Registry* for live connections, *Strategy*/handler
  map for per-event behavior, *Adapter* around external clients (S3, Kafka), *Repository*
  for DB access. Don't force a pattern onto a problem that doesn't have its shape.
- **Scalability-aware.** Anything that breaks with more than one replica (in-memory state,
  local timers, single consumers) is marked with a comment naming the limit and the fix.
- **Readable code:**
  - Descriptive names. A boolean condition longer than one clause gets a named
    variable or function.
  - Small functions (roughly one screen), early returns, no nested ternaries.
  - No cryptic idioms (`return void x`, dense chained expressions, magic numbers).
    Name constants.
  - Comments explain *why*, not *what*.
- **Consistency.** Match the existing structure of the service you touch. If a
  change makes a file mix concerns, split it as part of that change.

## Roadmap

Work follows `docs/ROADMAP.md` in order. Before each experiment, ask the user for their
prediction. Tick an item only when it has been run **and** its Q&A entry exists in
`docs/DESIGN-DECISIONS.md`.

## Commands

```bash
make up      # .env + TLS certs + build + start (only gateway :443 is exposed)
make ps      # wait until everything is healthy
make demo    # end-to-end walkthrough (demo/client.py); this is the main test
make logs    # follow all services
make kafka-ui  # opt-in read-only Kafka dashboard on http://127.0.0.1:8080 (profile tools)
# Grafana (traces + logs, always on): http://127.0.0.1:3000 → Explore → Tempo / Loki
docker compose exec -T lgtm curl -sG localhost:3200/api/search --data-urlencode 'q={ name = "PUT /v1/files/:id/like" }'  # find traces (TraceQL)
docker compose exec -T lgtm curl -s localhost:3200/api/traces/<traceId>   # full trace JSON; span ids are base64
make down    # stop, keep data
make reset   # stop + wipe volumes (needed after editing db/init/*)
docker compose up -d --build <service>   # rebuild one service after a code change
docker compose exec postgres psql -U api_user -d mediashare
```

There is no unit test suite. `make demo` asserts every flow.
Ad-hoc scripts: `.venv/bin/python`, `sys.path.insert(0, "demo")`, `from client import get_token`
(seeded users, same defaults as the demo; keeps passwords out of chat).

## Architecture

- `services/api`: Node 24 + TS (Fastify 5). Auth (Keycloak JWT), presigned S3 URLs,
  idempotency keys, transactional outbox relay (`src/outbox.ts`).
- `services/processor`: Python 3.14 Kafka consumer. Scan + thumbnail, CAS claim, retry/DLQ,
  expired-claim reaper (`src/consumer.py`, `src/db.py`).
- `services/notifier`: Node consumer (separate consumer group) + SSE endpoint
  `GET /v1/events` for the browser (`src/events-server.ts`, `src/stream-registry.ts`).
- `packages/auth`: shared JWT verification (`@mediashare/auth`), used by api and notifier.
  Node services are a pnpm workspace (`pnpm-workspace.yaml`; shared package referenced as
  `workspace:*`) built by one two-stage `services/node.Dockerfile` from the repo root
  (build context `.`; `.dockerignore` keeps `.env` and certs out). Adding a dependency:
  `pnpm --filter <service> add <pkg>`, then commit `pnpm-lock.yaml` (the image build uses
  `--frozen-lockfile` and fails on a stale lockfile).
- `web/`: static browser app (`app.localhost`), native ES modules in `web/js/`, no build step.
- `gateway/nginx.conf`: TLS, host routing, per-IP rate limit, CSP for the web app.
- `db/init/`: schema and roles. **Runs only on a fresh volume.** Schema changes need
  `make reset` (or a manual `ALTER` on a running db).
- `lgtm` (`grafana/otel-lgtm`): OTLP backend for traces (Tempo) and logs (Loki), on `data`.
  Tracing is zero-code, configured by the `x-otel-env` / `x-node-otel-env` compose anchors.
  How context crosses each hop: `docs/ARCHITECTURE.md` "Tracing".
- Kafka topics: `file-events` (3 partitions), `file-events-retry`, `file-events-dlq`.
  Auto-create is off; topics are made by `kafka-init` in `docker-compose.yml`.

## Gotchas

- Delivery is at-least-once everywhere. Every consumer must stay idempotent.
- The processor DB role only has `SELECT, UPDATE` on `files`. It cannot write the outbox.
- Networks: the gateway is on `edge` only and cannot reach postgres/kafka/redis. Keep it that way.
  api and notifier are on both networks (the notifier serves SSE to the browser).
- Shared compose values live in `x-` anchors at the top of `docker-compose.yml`
  (`x-web-origin`, `x-auth-env`). Reference them; don't repeat the literals.
- Tracing: auto-propagation stops at stored data. A new event path that goes through a DB
  row or an open stream must carry `traceparent` by hand (see the outbox column).
  - Node services are ESM: `NODE_OPTIONS` must keep the `--experimental-loader` hook, or
    `import pg` etc. bypass instrumentation silently.
  - New browser request headers must be added to the api CORS `allowedHeaders`, or the
    browser drops the request ("Failed to fetch") while the api logs nothing.
  - Processor logging: `log.setup()` keeps OTel's `LoggingHandler`; don't `handlers.clear()`.
  - Tempo search via `curl` to `lgtm:3200` with `start`/`end` misbehaved; search without them.
- Docs live in `docs/` (ARCHITECTURE, SECURITY, DESIGN-DECISIONS). Keep them in sync with the code.
- `CONTEXT.md` is the domain glossary (File, Published file, Feed, Lease…). Use its terms;
  update it when a term is settled.
- `docs/adr/` records decisions that are hard to reverse, surprising, and a real trade-off.
  Read the relevant ADR before "fixing" something that looks odd.

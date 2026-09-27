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
make demo    # end-to-end walkthrough (tools/demo/client.py); this is the main test
make logs    # follow all services
make kafka-ui  # opt-in read-only Kafka dashboard on http://127.0.0.1:8080 (profile tools)
# Grafana (traces + logs, always on): http://127.0.0.1:3000 → Explore → Tempo / Loki
docker compose exec -T lgtm curl -sG localhost:3200/api/search --data-urlencode 'q={ name = "PUT /v1/files/:id/like" }'  # find traces (TraceQL)
docker compose exec -T lgtm curl -s localhost:3200/api/traces/<traceId>   # full trace JSON; span ids are base64
make down    # stop, keep data
make reset   # stop + wipe volumes (needed after editing infra/postgres/init/*)
docker compose up -d --build <service>   # rebuild one service after a code change
docker compose exec postgres psql -U api_user -d mediashare
```

There is no unit test suite. `make demo` asserts every flow.
Ad-hoc scripts: `.venv/bin/python`, `sys.path.insert(0, "tools/demo")`, `from client import get_token`
(seeded users, same defaults as the demo; keeps passwords out of chat).

## Code layout inside an app

Feature folders plus adapters. Dependencies point one way: `routes → service → repository`,
and everything external (Postgres, S3, Redis, Kafka) is reached only through `adapters/`.

- `main.ts` / `main.py`: composition root. Builds and wires the parts; no logic.
- `<feature>/routes.ts`: HTTP only (schema, call the service, serialize). No SQL, no S3.
- `<feature>/service.ts`: what an operation does, step by step. No HTTP, no SQL.
  Expected failures are `throw new DomainError(code, message)` (`src/errors.ts`); the
  error handler in `http/app.ts` maps the code to a status. Anything else is a logged 500.
- `<feature>/repository.ts`: SQL only. Writes that must emit an event call
  `insertOutboxEvent` inside the same transaction.
- `http/`: Fastify app, hooks (auth, rate limit), schemas shared across features.

A new endpoint touches its feature's three files; a new external system gets an adapter.

**Every app follows this shape, the browser app included.** No `lib/`, `utils/` or
`helpers/` junk drawers, and no single controller for all features. Decide the folders
*before* writing the first file. `apps/web/src/` maps the same layers:

- `main.tsx`: entry (finish the login redirect, render). `app/`: composition only (page
  switch, nav shell, wiring one feature's event to another's refresh).
- `features/<feature>/`: `<feature>-api.ts` = the api endpoints it calls (like a
  repository: HTTP only), `use-<feature>.ts` = state + actions (like a service),
  `*-page.tsx` / components = rendering only (like routes). Features don't import each
  other's hooks; `app/` connects them.
- `adapters/`: everything external (api HTTP client, S3 presigned upload, Keycloak endpoints).
- `components/ui/`: shadcn-generated, edit sparingly; `components/`: shared presentational bits.

Top level: `apps/` (deployed), `packages/` (shared libs), `infra/` (third-party config),
`tools/` (demo, scripts; never deployed), `docs/`.

- `apps/api`: Node 24 + TS (Fastify 5). Auth (Keycloak JWT), presigned S3 URLs,
  idempotency keys, transactional outbox relay (`src/messaging/outbox.ts`).
- `apps/processor`: Python 3.14 Kafka consumer. Scan + thumbnail, CAS claim, retry/DLQ,
  expired-claim reaper (`src/pipeline/handler.py`, `src/adapters/db.py`); poll/commit
  loop in `src/kafka_loop.py`.
- `apps/notifier`: Node consumer (separate consumer group) + SSE endpoint
  `GET /v1/events` for the browser (`src/sse/events-server.ts`, `src/sse/stream-registry.ts`).
- `packages/auth`: shared JWT verification (`@mediashare/auth`), used by api and notifier.
  Node services are a pnpm workspace (`pnpm-workspace.yaml`; shared package referenced as
  `workspace:*`) built by one two-stage `apps/node.Dockerfile` from the repo root
  (build context `.`; `.dockerignore` keeps `.env` and certs out). Adding a dependency:
  `pnpm --filter <service> add <pkg>`, then commit `pnpm-lock.yaml` (the image build uses
  `--frozen-lockfile` and fails on a stale lockfile).
- `apps/web/`: browser app (`app.localhost`), React + TS + Tailwind + shadcn, built by Vite
  (`apps/web.Dockerfile`: build stage, then nginx serves `dist/`). ADR 0004.
- `infra/gateway/envoy.yaml`: Envoy edge. TLS, host routing, security headers/CSP, JWT check
  for `api.localhost` (`jwt_authn`; services verify again), per-IP and
  per-user (JWT `sub`) limits through the `ratelimit` service (`infra/ratelimit/config.yaml`, counters in Redis).
  `web` (stock nginx) serves `apps/web`; Envoy doesn't serve files.
- `infra/postgres/init/`: schema and roles. **Runs only on a fresh volume.** Schema changes need
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
  (`ratelimit` bridges edge and data to reach Redis; the gateway only talks gRPC to it.)
- Gateway config is a single-file bind mount: after editing `envoy.yaml`, run
  `docker compose restart gateway` (an editor's save replaces the inode). Validate first:
  `docker compose run --rm --no-deps gateway --mode validate -c /etc/envoy/envoy.yaml`.
- curl resolves every `*.localhost` to loopback itself (RFC 6761), ignoring Docker DNS.
  Inside the `loadtest` network use `curl --resolve host:443:<gateway ip>`.
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

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
an event row in one postgres transaction (`services/api/src/file-routes.ts`, `withTransaction`; helper `insertOutboxEvent` in `outbox.ts`),
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
   return the original file instead of creating twins (`services/api/src/file-routes.ts`).
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
Rejected alternatives: [ADR-0001](adr/0001-processing-claims-are-leases.md).

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
CLI demo uses the password grant while the browser app uses auth-code + PKCE (next
answer), and why logout/revocation is JWTs' weak spot (short TTL + refresh rotation is
the standard answer).

## Q: What is PKCE and why does a browser app need it?

**A:** A browser app is a **public client**: anything shipped to the browser is readable,
so it can't hold a client secret. Without a secret, whoever holds the authorization
`code` can redeem it for tokens, and the code travels through the most leak-prone place
there is: the URL (history, logs, other apps, malicious extensions).

PKCE (RFC 7636) replaces the static secret with a **one-time secret per login**
(`web/app.js`, `login()` / `handleRedirect()`):

1. The app makes a random `code_verifier` and sends only `code_challenge = SHA-256(verifier)`
   in the `/auth` redirect.
2. Keycloak stores the challenge with the issued code.
3. At `/token` the app sends the verifier; Keycloak hashes it and compares.

An intercepted code is useless without the verifier, and the verifier never touched the
URL. `state` is a separate thing: it binds the callback to the login *this* tab started
(login CSRF). The `media-web` client **enforces** S256 (`keycloak/media-realm.json`);
a request without a challenge gets `invalid_request`.

Follow-ups:
- *"Where do tokens live?"* In a JS variable only. `localStorage` survives forever and any
  XSS can read it; memory limits theft to the XSS's lifetime. The strict CSP on
  `app.localhost` (`gateway/nginx.conf`) is the XSS mitigation. Cost: a reload loses the
  tokens, so the app does a **silent login** on load: the same PKCE redirect with
  `prompt=none` ("only if you already know me, never show a form"). With a Keycloak SSO
  cookie it comes straight back with a code; without one, `error=login_required` and the
  Log in button appears. A load that *is* a callback never starts another silent login
  (no redirect loop). The alternatives: a refresh token in `sessionStorage` (XSS can
  steal it) or a BFF with an `HttpOnly` cookie (the production answer, one more service).
- *"How do you refresh?"* Lazily, 30 s before expiry, at the moment a token is needed
  (`accessToken()`), with one shared in-flight refresh. Timers are unreliable: background
  tabs throttle them and laptops sleep.
- *"Production-grade?"* A **BFF** (backend-for-frontend): a server-side component does the
  OAuth flow as a *confidential* client and gives the browser only an `HttpOnly`,
  `SameSite` session cookie. JS never sees a token, so XSS can act *as* the user but
  can't steal the token. Cost: a stateful server and CSRF protection.

## Q: How does SSO work across apps, and what does the IdP keep per app?

**A:** After one login Keycloak sets a **session cookie on its own domain**
(`auth.localhost`). Any other client (`media-web`, `media-cli`, Keycloak's own
`account-console`) redirects to `/auth`; the browser sends that cookie, so Keycloak returns
a code **without a form**. One login, many apps; logout can end the session for all.

Experiment (run): log in on `https://app.localhost`, then open
`https://auth.localhost/realms/media/account`. No password prompt: the gateway log shows
`/auth` → 302 straight back with a code. It surfaced two bugs worth knowing:

- **Rate limit vs page weight.** The account console loads ~25 static files in one burst,
  drained the per-IP `edge` bucket, and the `/token` POST right after got 429. Fix:
  `/resources/` is exempt (`gateway/nginx.conf`), like the web app's static files.
- **Signature valid ≠ token meant for me.** The Account API returned 401: seeded users
  had only `user`, not the realm default role, so their tokens carried no
  `aud: account`. Keycloak's own APIs check `aud`; ours only check `iss` (fine while one
  product trusts this realm; with several, each service should check `aud`).

Follow-ups:
- *"Why pin user ids in the realm JSON?"* The api keys users by `sub` (ADR 0002). Keycloak
  here has no volume, so re-importing the realm minted new `sub`s while postgres kept the
  old ones, and `UNIQUE (username)` failed (500). Stable ids make the seed match the data
  it already produced. In production the IdP database is persistent and `sub` never changes.

## Q: How does CORS work with presigned S3 uploads?

**A:** CORS is enforced **by the browser, not the server**. The server only declares which
origin may read its responses; curl and the Python demo ignore it entirely.

A request with a non-simple method (`PUT`, `DELETE`) or header (`Authorization`,
`Content-Type: application/json`) triggers a **preflight**: `OPTIONS` with `Origin`,
`Access-Control-Request-Method` and `-Headers`. Only if the answer names our origin and
allows that method and those headers does the browser send the real request.

What we saw, in order:
1. **api without CORS**: `OPTIONS /v1/files` → 404 with no `Access-Control-*`. The gateway
   log shows *only* the OPTIONS; the `GET` never left the browser. JS sees only
   `Failed to fetch`: it is not allowed to learn why.
2. **api with `@fastify/cors`** (`services/api/src/server.ts`): one exact origin from
   `WEB_ORIGIN`, allowed headers `Authorization, Content-Type, Idempotency-Key`,
   `exposedHeaders: Retry-After` (else JS can't read it on a 429), `maxAge: 600` so each
   call doesn't cost two round trips. Preflights are answered before the auth hook: they
   never carry a token.
3. **Presigned PUT** to `s3.localhost`: `Content-Type: image/png` makes it non-simple, so
   there is a preflight to the *storage* origin. The prediction was "SeaweedFS rejects it".
   Wrong for SeaweedFS (its `-s3.allowedOrigins` defaults to `*`, reflecting any Origin),
   right for **AWS S3**, which rejects every preflight until the bucket has a CORS rule.
   We now pin `-s3.allowedOrigins=https://app.localhost` (`docker-compose.yml`); on AWS it
   is a per-bucket rule managed as code (Terraform `aws_s3_bucket_cors_configuration`).

Follow-ups:
- *"Is CORS a security boundary for S3 here?"* No. The SigV4 signature is. CORS decides
  which *pages* may read responses; a presigned URL is a bearer capability either way.
- *"Why did an evil-origin preflight to the api get 204?"* The api answers with a fixed
  `Access-Control-Allow-Origin: https://app.localhost`; the browser compares it to its own
  origin and blocks. The server doesn't reject; it declares.
- *"`*` with credentials?"* Forbidden by the spec. Our requests use a bearer header, not
  cookies, so no `Allow-Credentials` is needed at all.

`make demo` step 13 asserts allow/deny for both the api and the presigned PUT.

## Q: How do you push live updates to the browser, and how is the stream authenticated?

**A:** Server-Sent Events: one long-lived HTTP response (`text/event-stream`) per tab,
served by the notifier at `GET /v1/events` (`services/notifier/src/events-server.ts`).
The notifier already consumes `file-events`, so every event whose `ownerId` matches the
stream's user is written to it (`StreamRegistry.publish`). SSE, not WebSocket, because
traffic is one-way (server → browser), it is plain HTTP through nginx, and it needs no
protocol upgrade.

The hard part is **auth**, because the browser's `EventSource` can't send an
`Authorization` header. The options:

| option | how | problem |
|---|---|---|
| token in the query string | `EventSource('/events?access_token=…')` | the token lands in access logs (our nginx log records `$request_uri`), browser history, `Referer` |
| cookie | `EventSource` sends cookies | needs a cookie session (i.e. a BFF) plus CSRF thinking |
| one-time ticket | `POST /events/ticket` with the bearer → 30 s single-use ticket in the URL | still a URL secret, but short-lived and single-use; needs a ticket store |
| **`fetch()` + header** (ours) | read `res.body` as a stream, parse frames (`web/js/sse-parser.js`) | we reimplement reconnect and parsing that `EventSource` gives for free |

**Token expiry on a long-lived connection.** The token is verified once, at connect.
Without more, a stream opened with a 5-minute token would stay authorized forever, and a
disabled user would keep receiving events. So the server closes the stream at the token's
`exp`, and the client reconnects with a refreshed token (`web/js/live-events.js`).
Observed: stream opened with `closesInMs: 299899`, closed exactly 5 minutes later, and
reopened in the same second. Revocation latency is bounded by the token TTL.

Follow-ups:
- *"What about events sent while disconnected?"* Not replayed. On every (re)connect the
  client reloads the file list (resync). The production answer is event ids +
  `Last-Event-ID` and a replayable store (e.g. Kafka offsets per user, or a short outbox).
- *"Reconnect storms?"* Exponential backoff with jitter (50–150 %), capped at 30 s, so a
  notifier restart doesn't bring every client back in the same instant.
- *"Proxies?"* nginx has `proxy_buffering off` (or events sit in a buffer) and a long
  `proxy_read_timeout`; the server writes a `: ping` comment every 25 s so idle
  intermediaries keep the connection and dead peers are detected.
- *"Does it scale?"* Not yet: the registry is in one process's memory. With 3 replicas,
  Kafka hands an event to whichever replica owns the partition, which may not hold the
  user's stream. Fix: Redis pub/sub fan-out (roadmap Phase 3).
- *"Production hardening?"* A BFF with an `HttpOnly` session cookie makes plain
  `EventSource` work, and a separate SSE gateway without Kafka credentials shrinks the
  internet-facing surface (see SECURITY.md, "Notifier edge exposure").

## Q: How is the feed built? Fan-out on read vs fan-out on write?

**A:** **Fan-out on read.** Nothing is precomputed. `GET /v1/feed` runs one query:
follows ⨝ files (Published only) ⨝ users, newest first, `LIMIT 20`
(`readFeed` in `services/api/src/social-routes.ts`). A partial index
`files (owner_id, created_at DESC, id DESC) WHERE visibility='public' AND status='ready'`
serves the per-author lookup.

| | fan-out on **read** (ours) | fan-out on **write** |
|---|---|---|
| on new post | nothing | copy the post id into every follower's feed (a Redis list or `feed_items` table) |
| on feed read | join over everyone you follow, sort, take 20 | read your precomputed list, done |
| cost grows with | people **you follow** × their posts, on **every read** | followers of the **author**, once per post |
| freshness | always exact (unpublish = gone instantly) | eventually consistent; unpublish/unfollow must clean up copies |
| breaks at | users following thousands of people | celebrities with millions of followers (one post = millions of writes) |

Measured (`scripts/experiment-feed-plan.sh`; 1000 authors × 20 Published files + 50k
private): following 3 users → nested loop over the partial index, 60 rows read,
**0.5 ms**. Following 1000 → the planner switches to a Seq Scan over all 20,000 Published
files + hash join, **27 ms**, to return 20 rows. The work is proportional to what you follow,
not to what you see.

Follow-ups:
- *"What do real systems do?"* **Hybrid**: fan-out on write for normal authors, fan-out on
  read merged in at read time for celebrities (Twitter's classic design). Roadmap Phase 3.
- *"Pagination?"* **Keyset**, not OFFSET: the cursor is the last row's `(created_at, id)`;
  the next page is `WHERE (created_at, id) < (cursor)`. New posts don't shift pages and deep
  pages cost the same as the first. The cursor carries `created_at` as Postgres text,
  because a JS `Date` keeps milliseconds and Postgres stores microseconds: a truncated
  cursor would repeat or skip rows.
- *"Anything else wrong in that plan?"* `liked_by_me` (an `EXISTS` per row) runs for every
  candidate row (`SubPlan loops=20000`), not only the 20 returned: Postgres computes it
  before the sort. Fix: compute it in an outer query over the page. Not done yet.
- Ordering is by upload time, so a file published a week after upload appears a week deep.
  A `published_at` column would fix it.

## Q: How are likes idempotent, and why can't the count drift?

**A:** A like is a **state**, not an action, so the api exposes it as
`PUT /v1/files/:id/like` (on) and `DELETE` (off). Both are idempotent: repeating them
changes nothing, so a retry after a timeout is safe with no Idempotency-Key.
(`POST /like` as a toggle would not be: a retried request would undo the first.)

One transaction (`likeFile` in `services/api/src/social-routes.ts`):
1. `SELECT … FOR UPDATE` the file, and only if it's Published (else 404).
2. `INSERT INTO likes … ON CONFLICT DO NOTHING RETURNING 1`. The `(user_id, file_id)`
   primary key does the deduplication, not application code.
3. **Only if a row was inserted**: `UPDATE files SET like_count = like_count + 1` and write
   the `file.liked` outbox row. A second like inserts nothing, so no second count and no
   second notification.

`like_count` is a **denormalized** copy of `count(*) FROM likes`: fast to read (the feed
shows it for every file), but it must be kept in step with the rows. Two ways to break that:
- **Lost update**: read the count into Node, write back `count + 1`. Measured
  (`scripts/experiment-like-race.sh`, 50 concurrent likers): **atomic `like_count + 1` →
  50; read-modify-write → 10**, while `likes` holds 50 rows. Under READ COMMITTED many
  sessions read the same value and each writes back value + 1.
- **Count without row, or row without count**: fixed by doing both in one transaction.

Follow-ups:
- *"Why FOR UPDATE and not FOR SHARE?"* Two transactions holding a share lock that both
  then UPDATE the row wait for each other: a deadlock. Take the lock you'll need.
- *"Hot rows?"* Every like on one file serializes on that file's row lock. A viral file
  (thousands of likes/s) bottlenecks there. Fixes: sharded counters (N rows, sum on read),
  or append likes and aggregate the count asynchronously.
- *"Duplicate notifications?"* Like → unlike → like sends two. Accepted. The outbox and
  Kafka are at-least-once, so the notifier may also see an event twice; for a
  notification that's harmless.
- *"Rate limiting?"* Likes cost a token like any write; a sixth rapid like gets 429 (the
  demo shows it). A social app would give likes their own, larger bucket.

## Q: How would you rate-limit this? 

**A:** Two layers, different keys, different failure domains: nginx per-IP (10 r/s,
dumb and early) and Redis per-user token bucket (capacity 5, 0.5/s refill) on every
state-changing request (anything but GET/HEAD/OPTIONS, so likes and follows count too). The bucket math is one **Lua script** — atomic, so concurrent requests can't
both spend the last token (the naive GET/SET race). 429s carry `Retry-After`, and the
demo client honors it — rate limiting is a protocol between server and client, not just
a wall. Design trade-off: the Redis layer **fails open** if Redis dies (nginx
still holds the perimeter); strictness vs availability is a per-system decision.
Run `make demo` step 11: 3 accepted, 9 rate-limited.

Lesson from 1b: the browser showed only `Failed to fetch`. The cause was nginx's per-IP
limit, which also covered the web app's static files. One login (Keycloak pages, ~10 ES
modules, token, files, feed) drained the bucket, and Docker Desktop makes every local
client the same IP. **An nginx 429 has no CORS headers, so the browser hides it from JS**:
a rate limit looks like a network error. Fixes: no `limit_req` on static files (nothing
upstream to protect), and no duplicate refetch on the first SSE connect. Per-IP limits
also hurt real users behind one NAT (offices, mobile carriers); that's why the per-user
Redis layer exists.

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
3. **Keyset pagination** — the feed uses it; `GET /v1/files` still uses OFFSET.
4. **Outbox → CDC** — polling works; Debezium is the grown-up version.
5. **Push delivery guarantees**: SSE push exists (`/v1/events`), but events missed while
   disconnected aren't replayed (resync only) and the stream registry is single-replica.
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

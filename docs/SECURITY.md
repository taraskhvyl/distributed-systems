# Security

Every control below is implemented in this repo and mapped to the code that does it.
Each entry names the threat, the control, and the accepted trade-off.

## Threat model (abridged STRIDE)

| threat                          | control                                                                 |
|---------------------------------|-------------------------------------------------------------------------|
| Spoofing                        | OIDC JWTs signed by Keycloak, verified locally via JWKS (`services/api/src/auth.ts`) |
| Tampering                       | TLS at the edge; SigV4-signed presigned URLs (method, path, host, expiry); sha256 checksum recorded at processing time |
| Repudiation                     | structured JSON logs with `eventId` correlation across api/processor/notifier |
| Information disclosure          | private uploads bucket + short-TTL presigned GETs; 404 (not 403) for other users' files; log redaction of `Authorization` |
| Denial of service               | two rate-limit layers (nginx per-IP, Redis per-user token bucket)        |
| Elevation of privilege          | realm roles (`user`/`admin`) checked server-side; per-service DB roles and scoped S3 identities |
| Lateral movement                | network segmentation: gateway cannot reach data stores; processor unreachable from the edge; notifier exposes only `/v1/events` |

## Identity and access

**Authentication** — Keycloak (OIDC) issues short-lived (300 s) RSA-signed access tokens.
The API **validates them locally**: it fetches Keycloak's public keys (JWKS) from the
*internal* network (`http://keycloak:8080/...`) but checks the `iss` claim against the
*external* issuer (`https://auth.localhost/realms/media`). No token-introspection
round-trip per request — validation is signature + claims, in-process.

- `jose` caches the JWKS and refetches on unknown `kid` → **key rotation works without restarts**.
- `requiredClaims: exp, iat, iss, sub` + 5 s clock tolerance.
- The demo uses the password grant (`directAccessGrants`) because it is a CLI demo. A real
  SPA/mobile client would use Authorization Code + PKCE; a real service-to-service client
  would use client-credentials.

**Authorization** — two layers:
1. **Ownership and publication**: the user id always comes from the JWT (`sub`), never
   from the client. Two named gates in `services/api/src/file-access.ts`:
   - `findReadableFile` (GET, download): owner, admin, or anyone if the file is
     Published (`public` AND `ready`). The rule is in the SQL `WHERE`, so a file that
     doesn't pass is simply not returned.
   - `findOwnedFile` / `owner_id = $2` in the UPDATE (complete, PATCH visibility): owner only.

   Everything else returns **404, not 403**: a 403 would confirm that a private file id
   exists. Non-owners get `serializePublicFile`, a separate allow-list of fields (no
   status, checksum or visibility), so a new column can't leak by default.
2. **Roles**: `DELETE /v1/files/:id` requires the `admin` realm role (`requireRole`).
   The demo shows both sides: user → 403, admin → 204.

## Network segmentation (the "subnets" story)

Two Docker networks stand in for VPC subnets + security groups:

- **edge** = public subnet. Hosts the gateway, keycloak, api, notifier, and storage's S3 endpoint.
- **data** = private subnet. Postgres, Kafka, Redis, storage, and the workers.

Only the gateway publishes a host port (443), plus the opt-in Kafka UI (`make kafka-ui`,
profile `tools`) on **127.0.0.1:8080 only**: a Kafka admin UI can read every message, so it
sits on `data`, is never routed through the gateway, and runs read-only. In production it
would live behind SSO/VPN, if at all. Grafana (`lgtm`) follows the same rule on
**127.0.0.1:3000**: it has anonymous admin and every log line, so it is never exposed beyond
loopback. Even so, the gateway's network membership
limits its *east-west* blast radius: it has no route to Postgres/Kafka/Redis. The processor
lives only on `data`, so the internet cannot address it at all.

### Notifier edge exposure

Since Phase 1a the notifier is on **both** networks: the gateway routes
`api.localhost/v1/events` (SSE) to it, and it fetches Keycloak's JWKS over `edge`.

What limits the exposure:
- No host port. Only the gateway reaches it, and nginx routes exactly one path
  (`location = /v1/events`); everything else on the notifier is unreachable from outside.
- Per-IP rate limit (`edge` zone) on connects, so reconnect storms are bounded.
- A valid Keycloak JWT is required (`@mediashare/auth`), and a user only receives events
  whose `ownerId` equals their `sub`.
- The stream is **closed at the token's `exp`** (`events-server.ts`). Without that, a token
  checked once at connect would authorize the stream forever: a disabled user would keep
  receiving events. Revocation latency is bounded by the token TTL (300 s).

What it costs: an internet-facing process now holds Kafka consumer credentials on the
`data` network. A bug in its HTTP handling is a path from the edge to Kafka. The hardened
design splits it: a thin **SSE gateway** on `edge` with no Kafka access, fed by the
notifier through Redis pub/sub (the same fan-out Phase 3 needs for multiple replicas).
TLS terminates at the gateway; internal traffic is plaintext inside the trusted network
(a standard trade-off — the upgrade path is mTLS via a service mesh).

## TLS

- A local dev CA (`ca.crt`, 10 years, `pathlen:0`) signs one server cert (825 days,
  RSA-2048) generated by `scripts/gen-certs.sh`. You trust only the CA.
- The server cert lists every host explicitly. A `*.localhost` wildcard does not work:
  browsers and macOS reject a wildcard directly under a single-label TLD (same rule that
  forbids `*.com`). It is also `CA:FALSE` with `extendedKeyUsage=serverAuth`, which macOS
  requires for TLS certs.
- nginx: TLS 1.2/1.3 only, `ssl_prefer_server_ciphers off` (modern guidance), session
  caching, HSTS + `X-Content-Type-Options: nosniff` + `X-Frame-Options` + `Referrer-Policy`
  on every route, JSON access logs, `return 444` for unknown hosts.
- Self-signed is correct for local dev (trust is bootstrapped by you); in production it is
  ACM/ACME-managed certs with rotation. The client sets `verify=False` *only* because the
  CA is your own laptop — with a real CA the same code path verifies normally.

## Storage security (the S3 story)

Buckets: `media-uploads` (private) and `media-thumbnails` (public read via the
`anonymous` identity scoped to `Read:media-thumbnails` — think S3 bucket policy
`Allow: s3:GetObject` for `*` on that bucket only).

**Presigned URLs** (SigV4) are the load-bearing security mechanism:

- The API presigns `PUT` (10 min) and `GET` (5 min) URLs with **scoped, non-admin
  credentials** (`api-svc`, granted `Read/Write:media-uploads` only).
- What is actually signed: the HTTP **method**, the **bucket + key** (path), the **host**,
  the **expiry**, and the signed-headers list (here: `host`). A presigned PUT cannot be
  replayed as a GET, cannot address another key or bucket, cannot outlive its expiry, and
  the signature is invalid if the Host header is rewritten — which is why the gateway
  preserves `Host: $host` when proxying to storage, and why SeaweedFS gets
  `-s3.externalUrl=https://s3.localhost` so it verifies the signature against the external
  host the client used.
- Headers that are *not* in the signed list (like `Content-Type` on a PUT) are not
  enforced by the signature — a nuance worth stating accurately.
- Direct upload means file bytes **never pass through the API**: no double bandwidth, no
  memory pressure, no multipart plumbing in app code. The API's job is metadata,
  authorization, and issuing URLs.

**Two production lessons already baked in:**

1. **SDK checksums break presigned PUTs.** Modern AWS SDKs append
   `x-amz-checksum-crc32` computed over an *empty* body when presigning, which the server
   then validates against real bytes → `BadDigest`. Fixed with
   `requestChecksumCalculation: 'WHEN_REQUIRED'` (`services/api/src/s3.ts`). This exact
   footgun ships in real products.
2. **Delete is bundled with write** in SeaweedFS's action model (`Write:bucket` covers
   PUT *and* DELETE), unlike AWS IAM's separate `s3:DeleteObject`. So `processor-svc`
  holds `Write:media-uploads` to purge infected originals — slightly broader than the
   intent. Honest trade-off to name; the alternative (a cleanup path owned by the api)
   adds coupling.

Least privilege in practice: `processor-svc` cannot write to `media-uploads` beyond that
bundled delete, cannot read `media-thumbnails` it doesn't need; `api-svc` cannot read
`media-thumbnails` at all; anonymous can read *only* the thumbnails bucket. The demo's
infected-file run proves the purge; the failed DLQ'd file from earlier debugging is
physical evidence in `file-events-dlq`.

### Thumbnails are capability URLs

`media-thumbnails` is anonymously readable, so a thumbnail is protected only by its
unguessable key (`<fileId>.webp`, a random UUIDv4 = 122 bits): a **capability URL**, like a
"anyone with the link" share. That's fine for private files whose id never left the
owner's browser. It is **not revocable**: after a file was public, its id sat in followers'
feeds, and making it private again doesn't stop those people from fetching the thumbnail
(browser cache, copied link). Accepted for now: small leak, CDN-friendly, no per-request
signing. The fix is on the roadmap: make the bucket private and return a short-lived
presigned GET in `thumbnailUrl` only to viewers who pass `findReadableFile`, so revocation
takes effect within the URL's TTL. Originals are not affected: downloads always go through
a 5-minute presigned URL behind the read gate.

## Rate limiting (defense in depth)

Two layers with different keys and failure domains:

1. **nginx `limit_req`** — per client IP, coarse (10 r/s, burst 20; 50 r/s for S3).
   Stops obvious floods before they touch application code. Cheap, dumb, effective.
2. **Redis token bucket per user** (`services/api/src/rate-limit.ts`) — capacity 5,
   refill 0.5/s, applied to mutating methods only. The check-and-decrement runs as a
   **single Lua script** — atomic under Redis's single-threaded execution, so two
   concurrent requests can never both take the last token (a naive
   GET→decrement→SET race would).

Trade-off made explicit: if Redis is down, `allowMutation` **fails open** (logs a warning,
allows the request). We chose availability over strictness for a demo; a payment ledger
might choose the opposite. The layered design means the nginx layer still holds when
Redis fails. Also note the client's share of responsibility: 429 + `Retry-After` only
works if clients honor it — the demo client does (`api_retry`).

## Database least privilege

- `api_user`: SELECT/INSERT/UPDATE/DELETE on `files`, DML on `outbox_events` (+ sequence
  grants — the classic gotcha: table grants do not cover `BIGSERIAL` sequences),
  SELECT/INSERT/UPDATE on `users`, SELECT/INSERT/DELETE on `follows` and `likes`.
- `processor_user`: SELECT/UPDATE on `files`, nothing else — it cannot insert rows, touch
  the outbox, or delete files.
- Schema is created by the init job (superuser), not by services. In production:
  migration tooling (Flyway/Alembic) + per-service users, or per-service schemas.

## Secrets

Dev: a git-ignored `.env` + compose interpolation; dev-grade values only. The compose
file uses `${VAR:?}` so missing secrets fail fast at startup, not at first use.
Production path: a real secret manager (Vault/Secrets Manager/SOPS), short-lived
credentials, rotation, and no plaintext env in CI logs. Keycloak passwords in the realm
JSON are demo seeds — production uses pre-hashed passwords or an external IdP.

## Trace context from clients

The api accepts the browser's `traceparent` header (the trace starts in the browser), so a
client chooses its own trace id and the "sampled" flag. Risks: a client can force every
request to be recorded (telemetry cost, a DoS lever) or reuse another trace's id to inject
spans into it. Accepted here because it is a lab and the ids carry no authority. In
production the edge restarts the trace for untrusted callers (or keeps the client id only
as a link) and applies its own sampling. The SSE frame's `traceId` is an id, not a secret.

## Production hardening checklist (deliberately out of scope here)

- WAF in front of the gateway (the nginx layer is not a WAF)
- mTLS or a service mesh for east-west traffic
- S3: SSE-KMS at rest, versioning + object lock on uploads, lifecycle to cold storage
- Postgres: PITR backups, encryption at rest, connection via IAM auth (RDS IAM)
- Observability: tracing exists (see ARCHITECTURE "Tracing"); production adds sampling,
  retention, auth on Grafana, and PII scrubbing of span attributes and logs
- Audit log as a first-class stream (who downloaded/presigned what)
- Quotas per user (storage caps), not just request rate limits
- CI: image scanning, dependency audit, SAST, signed images
- Chaos drills: kill kafka/api/processor and verify recovery — the healthchecks and
  restart policies are already in place for this

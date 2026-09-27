---
status: accepted
---

# JWTs are verified twice: at the edge and in every service

The gateway validates Keycloak access tokens for `api.localhost` (Envoy `jwt_authn`,
`infra/gateway/envoy.yaml`), and api and notifier **still verify the same token themselves**
(`packages/auth`). Envoy forwards the `Authorization` header (`forward: true`) for that.
This looks like duplicated work. It is deliberate: the two checks do different jobs.

- **Edge = filter.** Junk and expired tokens get their 401 before they take a request
  thread, a DB connection or an SSE stream (measured: the api logged 0 of them). It also
  gives the edge a verified `sub` to key a per-user limit on.
- **Service = guarantee.** A service takes the caller's identity only from a signature it
  checked itself, never from a header someone else set.

## Considered options

- **Trust the edge**: services drop `packages/auth` and read claims from a header Envoy sets
  (`forward_payload_header`). Rejected. api and notifier are on the `edge` network with
  keycloak, storage and ratelimit, and any of them can call `api:3000` directly, bypassing
  Envoy and sending any `sub`. A route or host added to Envoy without the per-route
  `requirement_name` would be open to everyone. And a compromised gateway could impersonate
  any user.
- **Services only, no edge check.** Rejected: bad tokens cost upstream resources, and the
  edge has no identity to rate-limit by.
- **A dedicated gateway ↔ services network instead of the service check.** Rejected as a
  *replacement*: it limits who can connect, but not what a request proves (the config-mistake
  and compromised-gateway cases stay open). In this compose file it is also awkward: Docker
  networks are all-or-nothing, and api must still share a network with keycloak for JWKS.
  In production it is a worthwhile extra layer (security groups, Kubernetes `NetworkPolicy`
  that only allows the gateway to reach the api's port), on top of this decision.

## Consequences

- Latency cost is negligible: 140 keep-alive GETs with `jwt_authn` on vs off, p50 13.8 vs
  14.1–15.4 ms, within noise. A signature check against a cached key takes microseconds;
  fetching keys is the expensive part, and both sides cache them.
- Issuer and JWKS URL live in two places (`envoy.yaml` and the `x-auth-env` anchor in `compose/apps.yml`;
  Envoy can't read compose env). Both sites carry a "change both" comment.
- Two independent key caches (10 min each). A Keycloak key rotation must publish the new
  key before signing with it, or one side rejects tokens the other accepts.
- Validation rules must stay equal (issuer, required claims, 5 s clock skew). If they
  drift, the edge passes what the service rejects, and the 401 comes from an unexpected
  place. The access log's `details` field tells which side answered.
- Revisit when services accept connections only from the gateway via mTLS (service mesh).
  Even then, keeping the in-service check is the zero-trust default.

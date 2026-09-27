# @mediashare/auth

Local verification of Keycloak access tokens. Used by `apps/api` and `apps/sse-gateway`.

```ts
import { AuthError, createTokenVerifier } from '@mediashare/auth'

const verify = createTokenVerifier({ issuer, jwksUrl })
const user = await verify(req.headers.authorization)   // { id, username, roles, expiresAt }
```

## What it checks

- `Authorization: Bearer <token>` is present → otherwise `AuthError('unauthorized')`.
- Signature against the realm's public keys (JWKS), cached; an unknown key id triggers one
  refetch (key rotation), with a cooldown so bad tokens can't hammer Keycloak.
- `iss` equals the configured issuer; `exp`, `iat`, `sub`, `preferred_username` present;
  small clock tolerance → otherwise `AuthError('invalid_token')`.

No call to Keycloak per request: that is what keeps the IdP off the hot path (measured in
the Phase 3 load tests).

## Why services verify even though Envoy already does

Envoy's `jwt_authn` filters junk at the edge, but a service takes the caller's identity only
from a signature it checked itself: anything on the `edge` network could call a service
directly and bypass Envoy. See ADR 0003.

## Why a package

One implementation of "who is this caller" for every service. The package is built into
each image at build time (pnpm `injectWorkspacePackages`), so services still deploy
independently.

---
status: accepted
---

# Users are a just-in-time local read model of Keycloak

Follows and Feeds need usernames and a way to find people, but Keycloak owns identities and
the api only sees a user's JWT. The api keeps its own `users (id = sub, username)` table and
**upserts the caller on every authenticated request** (`rememberUser` hook,
`apps/api/src/users/repository.ts`), from the token's `sub` and `preferred_username`. The upsert
only writes when the username changed. `files.owner_id`, `follows` and `likes` reference it
with foreign keys.

## Considered options

- **Keycloak Admin API per request.** Rejected: the api would need an admin service
  account, every feed render would depend on a second service being up, and you can't join
  across an HTTP call.
- **Sync from Keycloak events** (event-listener SPI or polling the admin API). Rejected
  for now: complete and fresher, but it's a new moving part to build and run.

## Consequences

- A user who has never called the api doesn't exist here: they can't be searched or
  followed until their first request. The demo logs `alice` in before `demo` searches.
- The copy is **stale by design**: a username change in Keycloak reaches us on that user's
  next request. If someone else takes the old name meanwhile, their upsert fails on the
  `UNIQUE (username)` constraint until the first user returns. Acceptable at this scale; a
  sync job would fix it.
- Deleting a user in Keycloak leaves the row, their follows and likes. Cleanup would be a
  Keycloak admin event → our DB, i.e. the sync option above.
- One extra DB round trip per request (usually a no-op write). A cache of "seen with this
  username" would remove it; not worth it yet.

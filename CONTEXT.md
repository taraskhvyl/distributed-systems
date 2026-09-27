# mediashare — domain glossary

**File** — media a user uploaded. Owned by exactly one user. Moves through
`pending → uploaded → processing → ready`, or ends `infected` / `failed`.

**Visibility** — who may see a File: `private` (owner and admins only, the default) or
`public`.

**Published file** — a File that is `public` **and** `ready`. Only published files appear
in Feeds, can be liked, or can be downloaded by anyone other than the owner. An infected
or failed File can never be published.

**User** — a person who can log in. Keycloak owns the identity; the api keeps a local copy
(`users`: Keycloak `sub` + username) created the first time the user calls the api. A user
who has never called the api can't be found or followed yet.

**Follow** — one user subscribing to another's Published files. One-directional, no
approval, and you can't follow yourself.

**Like** — one user's mark on one Published file. At most one per user and file; liking
again changes nothing. The file's owner is notified of a new Like, not of an unlike.

**Feed** — the Published files of the users you follow, newest first (by upload time).

**Live event** — an event pushed to a user's open browser tabs while they are connected
(SSE), e.g. "your file is ready", "alice liked your file". At-most-once: a tab that isn't
connected misses it and resyncs by reloading. Not stored.

**Claim** — a processor taking exclusive-by-intent ownership of one File's processing.

**Lease** — a Claim that expires. An expired Claim may be taken over by another processor,
so a Lease does not guarantee only one processor ever works on a File.

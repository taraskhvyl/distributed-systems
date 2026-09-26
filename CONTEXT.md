# mediashare — domain glossary

**File** — media a user uploaded. Owned by exactly one user. Moves through
`pending → uploaded → processing → ready`, or ends `infected` / `failed`.

**Visibility** — who may see a File: `private` (owner and admins only, the default) or
`public`.

**Published file** — a File that is `public` **and** `ready`. Only published files appear
in Feeds, can be liked, or can be downloaded by anyone other than the owner. An infected
or failed File can never be published.

**Feed** — the Published files of the users you follow, newest first.

**Claim** — a processor taking exclusive-by-intent ownership of one File's processing.

**Lease** — a Claim that expires. An expired Claim may be taken over by another processor,
so a Lease does not guarantee only one processor ever works on a File.

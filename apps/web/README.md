# web

The browser app at `https://app.localhost`: an Instagram-style UI for uploading, publishing,
following, liking and watching files get processed live. React 19 + TypeScript + Tailwind
+ shadcn/ui, built by Vite; served as static files by a stock nginx container (ADR 0004).

## What it shows off

- **Login with hand-written PKCE** against Keycloak (client `media-web`, public). Tokens live
  in JS memory only (never `localStorage`) and are refreshed before they expire.
- **Direct-to-S3 upload** with a progress bar: the api hands out a presigned PUT URL and
  the bytes never pass through the api.
- **Live events** over SSE via `fetch()` streaming (so it can send the `Bearer` header),
  with reconnect + backoff and a resync on every (re)connect.
- **Tracing from the browser**: each request gets a `traceparent`, so a click shows up as
  the root of a trace in Grafana.

## Layout

Same layering as the services: features + adapters.

```
src/
  main.tsx          entry: finish the login redirect, render
  config.ts         URLs, client id, refresh margin
  app/              composition only: page switch, nav shell, wiring features together
  features/<name>/  <name>-api.ts = HTTP calls, use-<name>.ts = state + actions, *.tsx = UI
    auth/           PKCE, token store, session
    files/          own files, upload dialog, file dialog, status badges
    feed/           feed page, post card, likes
    people/         search, follow
    live-events/    SSE client + parser, hook
    log/            in-app event log sheet
  adapters/         api HTTP client, S3 presigned upload, Keycloak endpoints, traceparent
  components/       shared bits; components/ui = shadcn-generated (edit sparingly)
```

Features don't import each other's hooks; `app/` connects them.

## Run

```bash
docker compose up -d --build web     # after any change (Vite builds inside the image)
pnpm --filter web build              # fast local typecheck + bundle, no Docker
```

Log in as a seeded user (see `tools/demo/client.py` for the defaults).

## Gotchas

- CSP on `app.localhost` (set by Envoy) blocks inline scripts and silently drops injected
  `<style>` tags.
- A new request header must be added to the api's CORS `allowedHeaders`, or the browser
  fails with "Failed to fetch" while the api logs nothing.

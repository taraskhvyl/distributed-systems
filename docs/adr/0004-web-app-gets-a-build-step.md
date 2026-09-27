---
status: accepted
---

# The web app gets a build step (React + TypeScript + Tailwind + shadcn, built by Vite)

`apps/web` was vanilla ES modules served as-is: no bundler, no framework, and "no build
step" was a documented rule. It is now React 19 + TypeScript + Tailwind + shadcn/ui,
bundled by Vite. The `web` image builds it in a Node stage and serves `dist/` with stock
nginx (`apps/web.Dockerfile`). The UI follows Instagram's layout (feed of post cards,
profile grid, create dialog).

The logic did not change. PKCE login, token refresh, the `fetch()` SSE reader, `traceparent`,
and the presigned S3 upload were ported to TypeScript almost line by line. Only the
rendering layer was rewritten. The folder layout mirrors the services (AGENTS.md, "Code
layout inside an app"): `features/<feature>/` with an api module, a hook and components,
plus `adapters/` for the api client, S3 and Keycloak.

## Considered options

- **Keep vanilla + hand-written CSS.** Rejected. Every new screen meant DOM-building code
  (`ui.js`) and CSS by hand, and the demo UI was hard to use for the experiments ahead
  (outlier detection, `--scale`, feed fan-out are easier to watch in a usable app).
- **Vanilla + JSDoc `@ts-check`** (types without a build). Rejected: it adds types but
  keeps the hand-built DOM, which was the actual pain.
- **A component library that needs no bundler** (web components from a CDN). Rejected: the
  CSP allows scripts only from our own origin, and vendoring a CDN build is a build step
  in disguise.

## Consequences

- **A build step exists.** A UI change needs `docker compose up -d --build web`; editing
  files no longer shows up on reload. The web package joins the pnpm workspace, so
  `pnpm-lock.yaml` must be committed with any web dependency change (the image uses
  `--frozen-lockfile`).
- **CSP now allows inline styles:** `style-src 'self' 'unsafe-inline'`
  (`infra/gateway/envoy.yaml`, app host). Radix's dialog scroll lock and sonner's toasts
  inject `<style>` tags. Without it, the browser silently dropped them (`sheet: null`):
  toasts rendered unstyled and the page scrolled behind open dialogs. Hashes can't cover
  them, because the scroll lock writes the measured scrollbar width into its CSS.
  `script-src` stays `'self'` only; that is what protects the in-memory tokens from XSS.
  The residual risk is CSS injection, which needs an HTML-injection bug first; React
  escapes all user text (filenames, usernames).
- **shadcn copies component source into the repo** (`src/components/ui/`) instead of
  depending on a versioned package. We own that code: upstream fixes don't arrive by
  themselves. Its CLI also resolved the `cn` helper to an unrelated npm package named `cn`;
  that was caught and replaced by the local `components/ui/utils.ts`. Review what
  generators add.
- **Bigger download:** ~113 KB gzipped JS (React + Radix + icons), where the vanilla app was
  a few KB. Irrelevant for a lab; in production it would sit behind a CDN.
- **No dev server in the stack.** Vite's dev server would run on another origin, which
  the api's CORS, Keycloak's redirect URIs and the CSP don't allow. Add one when rebuild
  time starts to hurt.

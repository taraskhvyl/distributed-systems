# One image recipe for every Node service. Build context is the repo root so the
# service can use shared workspace packages (packages/*).
# Usage (compose): build: { context: ., dockerfile: services/node.Dockerfile, args: { SERVICE: api } }

# --- build: all dependencies (incl. TypeScript), compile, then cut a production folder ---
FROM node:24-alpine AS build
ARG SERVICE
# corepack installs the exact pnpm version pinned in package.json ("packageManager").
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests + lockfile first: the dependency layer is cached until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/auth/package.json packages/auth/
COPY services/api/package.json services/api/
COPY services/notifier/package.json services/notifier/
# --frozen-lockfile: install exactly what pnpm-lock.yaml pins; fail if it's out of date.
# The whole workspace (3 small packages), not a --filter: a filtered install skips the
# devDependencies (TypeScript) of the workspace packages the service depends on.
# This stage is discarded; the runtime image only gets what `deploy` writes.
RUN pnpm install --frozen-lockfile

COPY packages/auth packages/auth
COPY services/${SERVICE} services/${SERVICE}
# deploy: copies the service's "files" (dist) + production deps, with workspace packages
# copied in (injected), into /deploy. No TypeScript, no sources, no other services.
RUN pnpm --filter @mediashare/auth build \
 && pnpm --filter "./services/${SERVICE}" build \
 && pnpm --filter "./services/${SERVICE}" deploy --prod /deploy

# --- runtime: only the deployed folder ---
FROM node:24-alpine
WORKDIR /app
COPY --from=build /deploy ./
USER node
CMD ["node", "dist/server.js"]

# One image recipe for every Node service. Build context is the repo root so the
# service can use shared workspace packages (packages/*).
# Usage (compose): build: { context: ., dockerfile: apps/node.Dockerfile, args: { SERVICE: api } }

# --- build: all dependencies (incl. TypeScript), compile, then cut a production folder ---
FROM node:24-alpine AS build
ARG SERVICE
# corepack installs the exact pnpm version pinned in package.json ("packageManager").
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests + lockfile first: the dependency layer is cached until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace member of pnpm-workspace.yaml except apps/web (own image): a member
# whose manifest is missing here is installed from the lockfile by luck, not by design.
COPY packages/auth/package.json packages/auth/
COPY packages/live-events/package.json packages/live-events/
COPY apps/api/package.json apps/api/
COPY apps/notifier/package.json apps/notifier/
COPY apps/sse-gateway/package.json apps/sse-gateway/
# --frozen-lockfile: install exactly what pnpm-lock.yaml pins; fail if it's out of date.
# The whole workspace (a few small packages), not a --filter: a filtered install skips the
# devDependencies (TypeScript) of the workspace packages the service depends on.
# This stage is discarded; the runtime image only gets what `deploy` writes.
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/${SERVICE} apps/${SERVICE}
# `{<dir>}...` = the service plus the workspace packages it depends on, built in dependency
# order, so a new shared package needs no change here. The braces are required: a bare
# "./apps/x..." silently selects only ./apps/x and its imports fail to resolve.
# deploy: copies the service's "files" (dist) + production deps, with workspace packages
# copied in (injected), into /deploy. No TypeScript, no sources, no other services.
RUN pnpm --filter "{./apps/${SERVICE}}..." build \
 && pnpm --filter "./apps/${SERVICE}" deploy --prod /deploy

# --- runtime: only the deployed folder ---
FROM node:24-alpine
WORKDIR /app
COPY --from=build /deploy ./
USER node
CMD ["node", "dist/main.js"]

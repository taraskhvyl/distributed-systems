# The browser app: build with Vite, then serve the static dist/ with stock nginx.
# Build context is the repo root (pnpm workspace + lockfile), like apps/node.Dockerfile.

# --- build: install the web package's deps, type-check, bundle ---
FROM node:24-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests + lockfile first: the dependency layer is cached until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
# --frozen-lockfile: install exactly what pnpm-lock.yaml pins. --filter: the web app has no
# workspace dependencies, so it doesn't need the services' packages.
RUN pnpm install --frozen-lockfile --filter web

COPY apps/web apps/web
RUN pnpm --filter web build

# --- runtime: nginx with its default config serves the files; no Node at runtime ---
FROM nginx:1.30-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

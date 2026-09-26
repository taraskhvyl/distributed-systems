# One image recipe for every Node service. Build context is the repo root so the
# service can use shared workspace packages (packages/*).
# Usage (compose): build: { context: ., dockerfile: services/node.Dockerfile, args: { SERVICE: api } }
FROM node:24-alpine
ARG SERVICE
WORKDIR /app

# Manifests first: the dependency layer is cached until a package.json changes.
COPY package.json tsconfig.base.json ./
COPY packages/auth/package.json packages/auth/
COPY services/${SERVICE}/package.json services/${SERVICE}/
RUN npm install --no-audit --no-fund --workspace services/${SERVICE} --include-workspace-root

COPY packages/auth packages/auth
COPY services/${SERVICE} services/${SERVICE}
RUN npm run build --workspace packages/auth \
 && npm run build --workspace services/${SERVICE} \
 && npm prune --omit=dev

WORKDIR /app/services/${SERVICE}
USER node
CMD ["node", "dist/server.js"]

# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root

FROM deps AS build
WORKDIR /app/apps/api
COPY apps/api/ ./
RUN npx prisma generate && npx nest build && npm prune --omit=dev -w apps/api

# One-off job: apply migrations and the idempotent platform seed (plans, permissions, settings), then exit.
#   docker compose -f docker-compose.prod.yml run --rm migrate
FROM deps AS migrator
WORKDIR /app/apps/api
COPY apps/api/prisma ./prisma
COPY apps/api/prisma.config.ts apps/api/tsconfig.json apps/api/package.json ./
COPY apps/api/src/rbac ./src/rbac
RUN npx prisma generate
CMD ["sh", "-c", "npx prisma migrate deploy && npx ts-node prisma/seed.ts"]

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/prisma.config.ts /app/apps/api/package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

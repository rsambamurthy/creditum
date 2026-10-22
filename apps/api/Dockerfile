# Creditum API — the same image runs on Railway (build/test), in a bank's cloud tenancy or on-premise (SDD Section 24.3).
# Build from the repository root:  docker build -f apps/api/Dockerfile -t creditum-api .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/guardrails/package.json tools/guardrails/
RUN npm ci --workspace apps/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/guardrails/package.json tools/guardrails/
RUN npm ci --workspace apps/api --include-workspace-root=false --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY apps/api/seed ./seed
COPY apps/api/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1
# Run migrations as a separate, explicit step in bank deployments:  node dist/database/cli.js migrate
CMD ["node", "dist/main.js"]

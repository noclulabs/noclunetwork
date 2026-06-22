# syntax=docker/dockerfile:1

# Multi-stage build: deps, build, runtime. Runs as a non-root user on Node 22.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# deps: install the full dependency set (cached on lockfile changes).
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# build: compile TypeScript, then prune to production dependencies.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# runtime: copy only the built output and pruned node_modules.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs noclu
COPY --from=build --chown=noclu:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=noclu:nodejs /app/dist ./dist
COPY --from=build --chown=noclu:nodejs /app/package.json ./package.json
USER noclu
EXPOSE 3000
CMD ["node", "dist/index.js"]

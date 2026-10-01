FROM ghcr.io/pnpm/pnpm@sha256:1c69b4492d1162f01481d634b3e93acc3aa8b550e80e6deb852c7991a1c5249c AS pnpm

FROM node:24.12.0-bookworm-slim AS base

WORKDIR /workspace

COPY --from=pnpm /opt/pnpm /opt/pnpm

RUN apt-get update \
  && apt-get install --yes --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/*

RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
  && pnpm --version

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile

COPY api api
COPY packages/config packages/config
COPY packages/contracts packages/contracts

RUN pnpm --filter @cliniq/contracts build \
  && pnpm --filter @cliniq/config build \
  && pnpm --filter @cliniq/api build \
  && pnpm --filter @cliniq/api --prod deploy --legacy /app \
  && pnpm --filter @cliniq/config --prod deploy --legacy /config \
  && rm /app/node_modules/@cliniq/config \
  && mkdir -p /app/node_modules/@cliniq/config \
  && cp -a /config/. /app/node_modules/@cliniq/config/

FROM node:24.12.0-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0

COPY --from=build --chown=node:node /app ./

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]

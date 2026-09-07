# Development setup

## Prerequisites

- Node.js 24 or a current supported Node.js LTS release
- pnpm 11+
- Docker Desktop with Docker Compose for local PostgreSQL and Redis

## Install dependencies

From `D:\project\CliniQPlatform`:

```powershell
pnpm install
Copy-Item .env.example .env
Copy-Item web\.env.example web\.env.local
```

The example values are local-development configuration only. Do not commit `.env` or `.env.local` files and do not place production credentials on a development machine.

## Start PostgreSQL and Redis

```powershell
docker compose -f infrastructure\docker\compose.yml up -d
```

Both services bind only to `127.0.0.1` and use persistent named development volumes.

## Start the API and web app

In separate terminals:

```powershell
pnpm dev:api
pnpm dev:web
```

The API listens on the configured `API_PORT` (default `4000`); the Next.js app defaults to `3000`.

## Quality checks

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## Migrations

No business migrations exist in Phase 1. After starting local PostgreSQL and copying `.env.example` to `.env`:

```powershell
pnpm db:migrate
pnpm db:rollback
```

Create a future approved migration with:

```powershell
pnpm --filter @cliniq/api exec node-pg-migrate create <name> -m ../database/migrations
```

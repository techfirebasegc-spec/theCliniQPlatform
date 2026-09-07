# Database foundation

PostgreSQL is the future transactional source of truth. This directory intentionally contains no business-domain tables or seed data in Phase 1.

Migrations are managed by `node-pg-migrate` through the API workspace:

- Create: `pnpm --filter @cliniq/api exec node-pg-migrate create <name> -m ../database/migrations`
- Run: `pnpm db:migrate`
- Roll back latest migration: `pnpm db:rollback`

Copy `.env.example` to `.env` before running migrations. Development database initialization is limited to starting the Docker Compose PostgreSQL service and then running approved migrations.

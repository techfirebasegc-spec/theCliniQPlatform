# Phase 1 foundation status

## Implemented

- pnpm monorepo workspace with web, API, contracts, and configuration packages.
- Next.js App Router TypeScript web shell with a minimal status page.
- Fastify TypeScript REST API with `/health` and dependency-aware `/ready` endpoints.
- Structured logging, secure headers, size-limited request bodies, controlled CORS, centralized error response shape, and secret-redacted authorization logs.
- Validated environment handling for `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `WEB_URL`, and `NODE_ENV`.
- PostgreSQL connection module, singleton-style Redis module factory, and `node-pg-migrate` command integration.
- Local Docker Compose definition for PostgreSQL and Redis, bound to localhost with persistent volumes.
- Tests for health, readiness, and configuration validation.

## Intentionally not implemented

- Authentication, users, tenants, network connections, business-domain database tables, appointments, booking, payment/Razorpay, settlements, chat, prescriptions, notifications, object storage, management applications, production infrastructure, and Firebase migration.

## Known limitations

- `/ready` returns `503` until local PostgreSQL and Redis are available; `/health` remains process-only.
- Docker must be installed to run the supplied development services.
- No migration files are present because Phase 1 intentionally has no business schema.
- The minimal web shell is not a CliniQ product-screen implementation and must not be treated as a UI redesign.

## Recommended next phase

Obtain approval for Phase 2 identity/access foundations and its account-linking, role, tenant-membership, and provider-policy decisions before implementing any business domain or database migration.

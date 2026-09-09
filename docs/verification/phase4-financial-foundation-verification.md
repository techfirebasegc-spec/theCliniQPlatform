# theCliniQ Phase 4 financial foundation verification

Run only against a new disposable PostgreSQL database; never use a production
or reference-application database.

1. Apply migrations through `pnpm --filter @cliniq/api migrate:up`.
2. Verify all Phase 4 tables, UUID keys, foreign keys, status/currency/amount
   checks, provider/idempotency unique constraints, and rule/policy indexes.
3. Verify direct updates/deletes of `financial_allocation_snapshots` fail.
4. Verify posted ledger transactions with unequal debit/credit totals fail at
   commit, while balanced transactions succeed and cannot later be edited.
5. Verify duplicate provider webhook event identities and payment/refund/
   settlement idempotency keys fail.
6. Verify settlement transition to `ELIGIBLE`, `SCHEDULED`, `PROCESSING`, or
   `SUCCEEDED` without `appointment_completed_at` fails.
7. Verify provider webhook facts/payload cannot be altered after insert while
   legitimate processing-status transitions remain possible.
8. Apply migration DOWN and confirm all Phase 4 tables/functions/triggers are
   removed while Phase 2 tables remain intact.

The application suite validates deterministic rules, integer-minor-unit money,
allocation generation, idempotency, webhook replay, state transitions,
adjustment separation of duties, provider signature boundary, reconciliation,
retry policy, and ledger balance. A live disposable PostgreSQL execution is a
required follow-up before any commit that enables the migration.

## Recorded live DEV verification result

The following verification was completed against the disposable PostgreSQL
database `cliniq_phase4_verify` on the theCliniQ DEV VPS. It was not an
application database and was not production data.

- Migration UP passed for all four theCliniQ migrations, including
  `20260910000000_phase4_financial_foundation`.
- Phase 4 financial schema verification passed: expected tables, indexes,
  foreign keys, state checks, integer-minor-unit monetary columns, unique and
  idempotency constraints, immutability protections, ledger balance protection,
  webhook event protections, adjustment separation of duties, and legal-hold
  structures were verified.
- The documented negative direct-SQL constraint tests passed, including
  allocation/webhook immutability, duplicate provider/idempotency rejection,
  settlement completion prerequisite, posted-ledger protection, and adjustment
  self-approval rejection.
- The targeted DOWN for
  `20260910000000_phase4_financial_foundation` passed.
- After Phase 4 DOWN, no Phase 4 financial tables remained. The Phase 2
  foundation remained intact: `accounts`, `authentication_identities`,
  `sessions`, `patient_profiles`, `doctor_profiles`, `tenants`, `clinics`,
  `tenant_memberships`, `tenant_invitations`, `network_connections`,
  `network_connection_capabilities`, `network_capability_proposals`,
  `network_connection_events`, and `audit_events`.

This verification did not perform a production payment, payout, settlement,
Razorpay credential operation, or production deployment. It did not use real
theCliniQ application data.

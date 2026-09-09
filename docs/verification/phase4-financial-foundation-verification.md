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

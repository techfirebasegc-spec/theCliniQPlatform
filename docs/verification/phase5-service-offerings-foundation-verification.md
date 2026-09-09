# theCliniQ Phase 5 Step 1 Service Offering verification

Run only against a fresh disposable PostgreSQL database. Never use production,
reference-project, or application data.

1. Apply migrations through the existing migration runner.
2. Verify `service_offerings`, `service_offering_versions`, and
   `service_offering_prices`; their UUID keys, explicit owner FKs, exactly-one
   owner check, status/range/currency/minor-unit checks, version uniqueness,
   and GiST no-overlap exclusion constraint.
3. Verify direct inserts with both owners, neither owner, or invalid owner FK
   fail; valid doctor-owned and clinic-owned rows succeed.
4. Verify an overlapping effective range fails, adjacent half-open ranges
   succeed, and a deterministic active version is readable at each instant.
5. Verify direct UPDATE/DELETE of a version or price fails, preserving
   historical pricing.
6. Target migration DOWN and verify only the three Step 1 tables, triggers,
   and functions are removed while all Phase 2 and Phase 4 tables remain.

`phase5-service-offerings-foundation-verification.sql` supplies deterministic
fixtures and expected-failure assertions for checks 2–5. It runs inside one
transaction and rolls back all fixture records.

## Recorded result

Local application validation passed with 75 tests, lint, typecheck, build, and
`git diff --check`. This Codex session did not have a `DATABASE_URL` configured
for the authorized disposable DEV PostgreSQL database, so migration UP/DOWN and
direct-SQL verification have not been executed from this workspace. The live
result remains pending; it must not be substituted with a local, production, or
application database.

No production database, payment provider, Razorpay credential, booking, or
financial transaction is part of this verification.

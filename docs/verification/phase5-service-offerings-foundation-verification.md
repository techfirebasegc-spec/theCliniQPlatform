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
`git diff --check`.

## Live DEV verification result

Live verification is **COMPLETE**. It was performed only against the fresh
disposable DEV PostgreSQL database
`cliniq_phase5_service_offerings_verify`; no production database, application
or business data, production payment provider, or Razorpay credential was
used.

- Migration UP succeeded through
  `20260911000000_phase5_service_offerings`.
- Schema verification passed for `service_offerings`,
  `service_offering_versions`, and `service_offering_prices`: UUID primary
  keys; explicit DoctorProfile/Clinic ownership foreign keys; exactly-one-owner
  check; status, effective-range, currency, and integer-minor-unit checks;
  version uniqueness; GiST effective-range no-overlap exclusion; and the
  version/price immutability triggers.
- Direct SQL verification passed: valid doctor-owned and clinic-owned offerings
  were accepted; both-owner, neither-owner, and invalid-owner-FK rows were
  rejected; overlapping effective versions were rejected; adjacent half-open
  ranges were accepted; and historical pricing remained readable.
- Direct version UPDATE/DELETE and direct price UPDATE/DELETE were rejected by
  the immutability protections.
- The official
  `phase5-service-offerings-foundation-verification.sql` fixture passed all
  checks, including schema presence, ownership-shape rejection, invalid FK,
  overlap, immutability, readable historical price, and rollback. Its fixture
  data was rolled back completely.
- Targeted DOWN for `20260911000000_phase5_service_offerings` succeeded. It
  removed only the three Service Offering tables and their immutability
  triggers/functions.
- Post-DOWN verification found 38 remaining tables. Phase 2 remained intact,
  including `accounts`, `doctor_profiles`, `clinics`, `tenants`,
  `network_connections`, and `tenant_memberships`. Phase 4 remained intact,
  including `commercial_rules`, `financial_allocation_snapshots`,
  `payment_intents`, `payments`, `refunds`, `settlements`,
  `ledger_transactions`, `ledger_entries`, `reconciliation_records`, and
  `provider_webhook_events`; `pgmigrations` also remained.

No production database, payment provider, Razorpay credential, booking, or
financial transaction is part of this verification.

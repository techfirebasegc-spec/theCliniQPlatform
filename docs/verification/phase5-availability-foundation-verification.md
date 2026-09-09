# theCliniQ Phase 5 Step 2 — Availability Foundation verification

## Scope

Verify only migration `20260912000000_phase5_availability_foundation.js` on a
fresh disposable PostgreSQL database after the Phase 2, Phase 4, and Phase 5
Step 1 migrations. No production data, Firebase, payment provider, booking,
reservation, or generated-slot data is used.

## Required checks

1. Migration UP creates only `availability_configurations`,
   `availability_rules`, `availability_windows`, and
   `availability_exceptions`, their indexes, and integrity functions/triggers.
2. Verify integer-seconds/capacity checks, version FK/unique relationship,
   canonical recurrence effective-range exclusion, same-day windows,
   duplicate/overlap guards, break containment, and exception vocabulary.
3. Execute `phase5-availability-foundation-verification.sql` inside its
   rollback-safe fixture transaction.
4. Verify direct SQL cannot supply a divergent derived UTC range; local input
   plus configuration IANA timezone is authoritative.
5. Run targeted DOWN and verify only Step 2 objects are removed while Phase 2,
   Phase 4, and Phase 5 Step 1 tables remain.

## Expected application checks

Run API/unit tests for controlled recurrence, IANA validation, DST spring skip
and fall earlier-fold selection, doctor/clinic authorization, IDOR denial,
audit outcomes, and configuration transaction rollback. These are application
layer checks and are not replaced by the SQL fixture.

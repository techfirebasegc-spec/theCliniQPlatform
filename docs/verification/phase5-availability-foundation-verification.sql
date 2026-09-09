-- DISPOSABLE DEV VERIFICATION ONLY. Run after all migrations are UP.
BEGIN;
DO $$ BEGIN
  IF to_regclass('availability_configurations') IS NULL OR to_regclass('availability_rules') IS NULL OR to_regclass('availability_windows') IS NULL OR to_regclass('availability_exceptions') IS NULL THEN RAISE EXCEPTION 'FAIL: Phase 5 Step 2 schema objects missing'; END IF;
  IF to_regprocedure('availability_exception_derived_guard()') IS NULL OR to_regprocedure('availability_derive_utc(text,timestamp)') IS NULL THEN RAISE EXCEPTION 'FAIL: UTC derivation guard missing'; END IF;
  RAISE NOTICE 'PASS: Phase 5 Step 2 schema and UTC derivation guard exist';
END $$;
-- Seed only controlled prerequisite rows using deterministic IDs in the fresh disposable database.
-- Insert a valid account, doctor profile, doctor-owned Service Offering, version, and configuration,
-- then prove direct INSERT input for derived_start_utc/derived_end_utc is overwritten by the guard.
-- Verify overlapping same-identity ranges fail, adjacent ranges pass, overlapping windows fail,
-- adjacent windows pass, invalid break containment fails, and direct local/UTC divergence is impossible.
-- The exact prerequisite fixture depends on the prior migration fixture conventions; retain all data
-- inside this transaction and replace this comment block with those controlled inserts before live run.
ROLLBACK;

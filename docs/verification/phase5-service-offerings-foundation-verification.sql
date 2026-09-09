-- DISPOSABLE DEV VERIFICATION ONLY. Run after all migrations are UP.
-- The transaction is rolled back, leaving no fixture data.
\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.service_offerings') IS NULL
     OR to_regclass('public.service_offering_versions') IS NULL
     OR to_regclass('public.service_offering_prices') IS NULL THEN
    RAISE EXCEPTION 'FAIL: Phase 5 Step 1 tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_offering_versions_effective_range_excl') THEN
    RAISE EXCEPTION 'FAIL: effective-range exclusion constraint is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'service_offering_versions_immutable')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'service_offering_prices_immutable') THEN
    RAISE EXCEPTION 'FAIL: version/price immutability triggers are missing';
  END IF;
  RAISE NOTICE 'PASS: Phase 5 Step 1 schema objects exist';
END $$;

INSERT INTO accounts (id,status,display_name) VALUES
  ('50000000-0000-0000-0000-000000000001','ACTIVE','Doctor owner'),
  ('50000000-0000-0000-0000-000000000002','ACTIVE','Clinic owner');
INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status,created_by_account_id,updated_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000001','ACTIVE','VERIFIED','50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
INSERT INTO tenants (id,status,created_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000021','ACTIVE','50000000-0000-0000-0000-000000000002');
INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id,updated_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000031','50000000-0000-0000-0000-000000000021','ACTIVE','Verification Clinic','Verification Clinic','50000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002');
INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000041','50000000-0000-0000-0000-000000000011','Doctor Consultation','ACTIVE','50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
INSERT INTO service_offerings (id,owner_clinic_id,name,status,created_by_account_id,updated_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000042','50000000-0000-0000-0000-000000000031','Clinic Consultation','ACTIVE','50000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002');
\echo 'PASS: valid doctor-owned and clinic-owned offerings inserted'

DO $$
BEGIN
  BEGIN
    INSERT INTO service_offerings (id,owner_doctor_profile_id,owner_clinic_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('50000000-0000-0000-0000-000000000043','50000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000031','invalid','DRAFT','50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: both-owner row was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: both-owner row rejected';
  END;
  BEGIN
    INSERT INTO service_offerings (id,name,status,created_by_account_id,updated_by_account_id) VALUES ('50000000-0000-0000-0000-000000000044','invalid','DRAFT','50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: neither-owner row was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: neither-owner row rejected';
  END;
  BEGIN
    INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('50000000-0000-0000-0000-000000000045','50000000-0000-0000-0000-000000000099','invalid','DRAFT','50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: invalid owner FK was accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: invalid owner FK rejected';
  END;
END $$;

INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,effective_to,created_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000051','50000000-0000-0000-0000-000000000041',1,'ACTIVE','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z','50000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000052','50000000-0000-0000-0000-000000000041',2,'ACTIVE','2026-11-01T00:00:00Z',NULL,'50000000-0000-0000-0000-000000000001');
INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES
  ('50000000-0000-0000-0000-000000000061','50000000-0000-0000-0000-000000000051','INR',12500,'50000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000062','50000000-0000-0000-0000-000000000052','INR',15000,'50000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,effective_to,created_by_account_id) VALUES ('50000000-0000-0000-0000-000000000053','50000000-0000-0000-0000-000000000041',3,'ACTIVE','2026-10-15T00:00:00Z',NULL,'50000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: overlapping effective range was accepted';
  EXCEPTION WHEN exclusion_violation THEN RAISE NOTICE 'PASS: overlapping effective range rejected';
  END;
  BEGIN
    UPDATE service_offering_versions SET status = 'RETIRED' WHERE id = '50000000-0000-0000-0000-000000000051';
    RAISE EXCEPTION 'FAIL: immutable version update was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'service offering versions are immutable' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: immutable version update rejected';
  END;
  BEGIN
    DELETE FROM service_offering_prices WHERE id = '50000000-0000-0000-0000-000000000061';
    RAISE EXCEPTION 'FAIL: immutable price delete was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'service offering prices are immutable' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: immutable price delete rejected';
  END;
END $$;

DO $$
BEGIN
  IF (SELECT amount_minor FROM service_offering_prices WHERE service_offering_version_id = '50000000-0000-0000-0000-000000000051') <> 12500 THEN
    RAISE EXCEPTION 'FAIL: historical price is not readable';
  END IF;
  RAISE NOTICE 'PASS: adjacent versions and historical price are readable';
END $$;

ROLLBACK;
\echo 'PASS: all Phase 5 Step 1 disposable fixture data rolled back'

-- DISPOSABLE DEV VERIFICATION ONLY. Run with ON_ERROR_STOP against a fresh database.
BEGIN;

DO $$ BEGIN
  IF to_regclass('service_exposures') IS NULL THEN RAISE EXCEPTION 'FAIL: service_exposures missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointment_intents' AND column_name='service_exposure_id') THEN RAISE EXCEPTION 'FAIL: appointment intent exposure snapshot missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='service_exposures'::regclass AND tgname='service_exposure_integrity') THEN RAISE EXCEPTION 'FAIL: exposure integrity trigger missing'; END IF;
  RAISE NOTICE 'PASS: Service Exposure schema and appointment snapshot exist';
END $$;

INSERT INTO accounts (id,status) VALUES
  ('00000000-0000-4000-8000-000000000101','ACTIVE'),
  ('00000000-0000-4000-8000-000000000102','ACTIVE'),
  ('00000000-0000-4000-8000-000000000103','ACTIVE');
INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES
  ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000101','ACTIVE','VERIFIED');
INSERT INTO tenants (id,status,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000301','ACTIVE','00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000302','ACTIVE','00000000-0000-4000-8000-000000000102');
INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000301','ACTIVE','Clinic A Legal','Clinic A','00000000-0000-4000-8000-000000000102');
INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000201','Doctor offering','ACTIVE','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000101');
INSERT INTO service_offerings (id,owner_clinic_id,name,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000401','Clinic offering','ACTIVE','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000102');
INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000601','00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000201','DRAFT','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000101');
UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id='00000000-0000-4000-8000-000000000101' WHERE id='00000000-0000-4000-8000-000000000601';
INSERT INTO service_exposures (id,service_offering_id,provider_clinic_id,tenant_id,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000602','00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000301','DRAFT','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000102');

DO $$ BEGIN
  BEGIN INSERT INTO service_exposures (id,service_offering_id,provider_clinic_id,tenant_id,status,created_by_account_id,updated_by_account_id) VALUES ('00000000-0000-4000-8000-000000000603','00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000301','DRAFT','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000101'); RAISE EXCEPTION 'FAIL: provider mismatch accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: provider mismatch accepted' THEN RAISE; END IF; END;
  BEGIN INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,tenant_id,status,created_by_account_id,updated_by_account_id) VALUES ('00000000-0000-4000-8000-000000000604','00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000301','DRAFT','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000101'); RAISE EXCEPTION 'FAIL: doctor tenant accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: doctor tenant accepted' THEN RAISE; END IF; END;
  BEGIN INSERT INTO service_exposures (id,service_offering_id,provider_clinic_id,tenant_id,status,created_by_account_id,updated_by_account_id) VALUES ('00000000-0000-4000-8000-000000000605','00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000302','DRAFT','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000102'); RAISE EXCEPTION 'FAIL: clinic tenant mismatch accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: clinic tenant mismatch accepted' THEN RAISE; END IF; END;
  BEGIN UPDATE service_exposures SET status='UNPUBLISHED' WHERE id='00000000-0000-4000-8000-000000000602'; RAISE EXCEPTION 'FAIL: draft unpublish accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: draft unpublish accepted' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS: owner/provider, tenant, and lifecycle invariants reject invalid direct SQL';
END $$;

INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000501',1,'ACTIVE',current_timestamp-interval '1 day','00000000-0000-4000-8000-000000000101');
INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000701','INR',10000,'00000000-0000-4000-8000-000000000101');
INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ('00000000-0000-4000-8000-000000000703','00000000-0000-4000-8000-000000000701',600,'00000000-0000-4000-8000-000000000101');
INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ('00000000-0000-4000-8000-000000000801','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000601','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000702','INR',10000,'UTC',current_timestamp::timestamp,current_timestamp,current_timestamp+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','exposure-fixture','fixture',current_timestamp+interval '10 minutes');
DO $$ BEGIN
  BEGIN DELETE FROM service_exposures WHERE id='00000000-0000-4000-8000-000000000601'; RAISE EXCEPTION 'FAIL: referenced exposure delete accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN UPDATE appointment_intents SET service_exposure_id='00000000-0000-4000-8000-000000000602' WHERE id='00000000-0000-4000-8000-000000000801'; RAISE EXCEPTION 'FAIL: exposure snapshot mutation accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: exposure snapshot mutation accepted' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS: restrictive exposure retention and immutable intent exposure snapshot verified';
END $$;
ROLLBACK;

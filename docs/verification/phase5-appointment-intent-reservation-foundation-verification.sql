-- DISPOSABLE DEV VERIFICATION ONLY. Run after all migrations are UP.
BEGIN;
CREATE FUNCTION pg_temp.expect_sqlstate(statement text, expected_state text, invariant_name text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    actual_state := SQLSTATE;
    IF actual_state = expected_state THEN
      RAISE NOTICE 'PASS: %', invariant_name;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL: % raised SQLSTATE %, expected %', invariant_name, actual_state, expected_state;
  END;
  RAISE EXCEPTION 'FAIL: % unexpectedly succeeded', invariant_name;
END;
$$;

DO $$
BEGIN
  IF to_regclass('appointment_intents') IS NULL
     OR to_regclass('slot_reservations') IS NULL
     OR to_regclass('service_offering_version_reservation_policies') IS NULL THEN
    RAISE EXCEPTION 'FAIL: Step 3.1 schema missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appointment_intent_context')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'slot_reservation_integrity') THEN
    RAISE EXCEPTION 'FAIL: Step 3.1 integrity triggers missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'appointment_intents'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%provider_doctor_profile_id IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%provider_clinic_id IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'FAIL: appointment intent provider XOR constraint missing';
  END IF;
  RAISE NOTICE 'PASS: Step 3.1 schema objects and integrity guards exist';
END $$;

INSERT INTO accounts(id,status) VALUES
  ('c3000000-0000-0000-0000-000000000001','ACTIVE'),
  ('c3000000-0000-0000-0000-000000000002','ACTIVE'),
  ('c3000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO doctor_profiles(id,account_id,status,professional_verification_status) VALUES ('c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000002','ACTIVE','VERIFIED');
INSERT INTO tenants(id,status,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000040','ACTIVE','c3000000-0000-0000-0000-000000000003','c3000000-0000-0000-0000-000000000003');
INSERT INTO clinics(id,tenant_id,status,legal_name,display_name,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000041','c3000000-0000-0000-0000-000000000040','ACTIVE','Verification Clinic','Verification Clinic','c3000000-0000-0000-0000-000000000003','c3000000-0000-0000-0000-000000000003');
INSERT INTO service_offerings(id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000010','Verification','ACTIVE','c3000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000002');
INSERT INTO service_offerings(id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000024','c3000000-0000-0000-0000-000000000010','Policy Verification','ACTIVE','c3000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000002');
INSERT INTO service_offerings(id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000025','c3000000-0000-0000-0000-000000000010','Other Doctor Verification','ACTIVE','c3000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000002');
INSERT INTO service_offerings(id,owner_clinic_id,name,status,created_by_account_id,updated_by_account_id) VALUES ('c3000000-0000-0000-0000-000000000026','c3000000-0000-0000-0000-000000000041','Clinic Verification','ACTIVE','c3000000-0000-0000-0000-000000000003','c3000000-0000-0000-0000-000000000003');
INSERT INTO service_offering_versions(id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES
  ('c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000020',1,'ACTIVE','2027-01-01Z','c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-00000000002d','c3000000-0000-0000-0000-000000000024',1,'ACTIVE','2027-01-01Z','c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-000000000027','c3000000-0000-0000-0000-000000000025',1,'ACTIVE','2027-01-01Z','c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-000000000028','c3000000-0000-0000-0000-000000000026',1,'ACTIVE','2027-01-01Z','c3000000-0000-0000-0000-000000000003');
INSERT INTO service_offering_prices(id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES
  ('c3000000-0000-0000-0000-000000000022','c3000000-0000-0000-0000-000000000021','INR',10000,'c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-000000000029','c3000000-0000-0000-0000-000000000027','INR',11000,'c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-00000000002a','c3000000-0000-0000-0000-000000000028','INR',12000,'c3000000-0000-0000-0000-000000000003');
INSERT INTO service_offering_version_reservation_policies(id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES
  ('c3000000-0000-0000-0000-000000000023','c3000000-0000-0000-0000-000000000021',600,'c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-00000000002b','c3000000-0000-0000-0000-000000000027',601,'c3000000-0000-0000-0000-000000000002'),
  ('c3000000-0000-0000-0000-00000000002c','c3000000-0000-0000-0000-000000000028',602,'c3000000-0000-0000-0000-000000000003');

SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO service_offering_version_reservation_policies(id,service_offering_version_id,hold_seconds,created_by_account_id)
  VALUES ('c3000000-0000-0000-0000-00000000002e','c3000000-0000-0000-0000-00000000002d',0,'c3000000-0000-0000-0000-000000000002')
$sql$, '23514', 'invalid reservation-policy hold duration rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO service_offering_version_reservation_policies(id,service_offering_version_id,hold_seconds,created_by_account_id)
  VALUES ('c3000000-0000-0000-0000-000000000024','c3000000-0000-0000-0000-000000000021',600,'c3000000-0000-0000-0000-000000000002')
$sql$, '23505', 'duplicate reservation policy for one version rejected');
DO $$ BEGIN
  RAISE NOTICE 'PASS: deterministic doctor and clinic prerequisite chains created';
END $$;
-- Valid doctor-owned and clinic-owned provider shapes.
INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
VALUES ('c3000000-0000-0000-0000-000000000030','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-01 10:00','2030-01-01T04:30Z','2030-01-01T05:00Z',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED','doctor-key','doctor-fingerprint',current_timestamp+interval '10 minutes');
INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_clinic_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
VALUES ('c3000000-0000-0000-0000-000000000032','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000041','c3000000-0000-0000-0000-000000000026','c3000000-0000-0000-0000-000000000028','c3000000-0000-0000-0000-00000000002a','INR',12000,'Asia/Kolkata','2030-01-01 11:00','2030-01-01T05:30Z','2030-01-01T06:00Z',1800,0,0,602,'PATIENT_PROVIDER','APPOINTMENT_INTENT','clinic-key','clinic-fingerprint',current_timestamp+interval '10 minutes');
DO $$ BEGIN RAISE NOTICE 'PASS: valid doctor-only and clinic-only provider intents inserted'; END $$;

-- The BEFORE context trigger runs before the provider-shape CHECK, so invalid shapes
-- fail closed through that trigger; the preceding catalog assertion proves the CHECK exists.
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,provider_clinic_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000033','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000041','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','both-provider','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'both provider parties fail closed');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000034','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','no-provider','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'missing provider party fails closed');

-- The context trigger binds the immutable offering, version, price, provider and policy snapshot.
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000035','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000027','c3000000-0000-0000-0000-000000000029','INR',11000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,601,'PATIENT_PROVIDER','APPOINTMENT_INTENT','wrong-version','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'offering and version mismatch rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000036','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000029','INR',11000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','wrong-price','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'price and version mismatch rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_clinic_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000037','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000041','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','wrong-provider','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'provider and service ownership mismatch rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000038','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-01 12:00','2030-01-01T06:30Z','2030-01-01T07:00Z',1800,0,0,601,'PATIENT_PROVIDER','APPOINTMENT_INTENT','wrong-policy','fingerprint',current_timestamp+interval '10 minutes')
$sql$, 'P0001', 'reservation policy snapshot from another version rejected');
DO $$ BEGIN RAISE NOTICE 'PASS: offering, version, price, provider and policy consistency enforced'; END $$;

-- The database deduplicates on actor plus idempotency key. Fingerprint comparison is
-- intentionally application-level conflict handling, so both conflicts are unique violations.
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-000000000039','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-02 10:00','2030-01-02T04:30Z','2030-01-02T05:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','doctor-key','doctor-fingerprint',current_timestamp+interval '10 minutes')
$sql$, '23505', 'same idempotency key and same fingerprint rejected by database');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO appointment_intents(id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
  VALUES ('c3000000-0000-0000-0000-00000000003a','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000010','c3000000-0000-0000-0000-000000000020','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000022','INR',10000,'Asia/Kolkata','2030-01-02 10:00','2030-01-02T04:30Z','2030-01-02T05:00Z',1800,0,0,600,'PATIENT_PROVIDER','APPOINTMENT_INTENT','doctor-key','different-fingerprint',current_timestamp+interval '10 minutes')
$sql$, '23505', 'same idempotency key and different fingerprint rejected by database');
DO $$ BEGIN RAISE NOTICE 'PASS: idempotency uniqueness is actor and key only; fingerprint conflict semantics remain application-level'; END $$;

INSERT INTO slot_reservations(id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at)
VALUES ('c3000000-0000-0000-0000-000000000031','c3000000-0000-0000-0000-000000000030','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000010','2030-01-01T04:30Z','2030-01-01T05:00Z',1,'HELD',current_timestamp+interval '10 minutes');

SELECT pg_temp.expect_sqlstate($sql$ UPDATE appointment_intents SET starts_at='2030-01-01T05:00Z' WHERE id='c3000000-0000-0000-0000-000000000030' $sql$, 'P0001', 'appointment intent booking context immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET appointment_intent_id='c3000000-0000-0000-0000-000000000032' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation appointment intent immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET service_offering_version_id='c3000000-0000-0000-0000-000000000027' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation capacity identity immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET provider_doctor_profile_id=NULL, provider_clinic_id='c3000000-0000-0000-0000-000000000041' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation provider context immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET starts_at='2030-01-01T05:00Z' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation start instant immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET ends_at='2030-01-01T05:30Z' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation end instant immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET capacity_units=2 WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation capacity units immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE slot_reservations SET expires_at=current_timestamp + interval '20 minutes' WHERE id='c3000000-0000-0000-0000-000000000031' $sql$, 'P0001', 'reservation expiry snapshot immutable');
SELECT pg_temp.expect_sqlstate($sql$ UPDATE service_offering_versions SET status='RETIRED' WHERE id='c3000000-0000-0000-0000-000000000021' $sql$, 'P0001', 'underlying service offering version history immutable');
DO $$ BEGIN RAISE NOTICE 'PASS: reservation capacity context remains a historical snapshot'; END $$;

-- Representative direct foreign-key checks cover the important prerequisite relationships.
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO slot_reservations(id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at)
  VALUES ('c3000000-0000-0000-0000-00000000003b','c3000000-0000-0000-0000-00000000ffff','c3000000-0000-0000-0000-000000000021','c3000000-0000-0000-0000-000000000010','2030-01-03T04:30Z','2030-01-03T05:00Z',1,'HELD',current_timestamp+interval '10 minutes')
$sql$, '23503', 'invalid appointment intent reference rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO service_offering_versions(id,service_offering_id,version_number,status,effective_from,created_by_account_id)
  VALUES ('c3000000-0000-0000-0000-00000000003c','c3000000-0000-0000-0000-00000000ffff',1,'ACTIVE','2031-01-01Z','c3000000-0000-0000-0000-000000000002')
$sql$, '23503', 'invalid service offering reference rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO service_offering_prices(id,service_offering_version_id,currency,amount_minor,created_by_account_id)
  VALUES ('c3000000-0000-0000-0000-00000000003d','c3000000-0000-0000-0000-00000000ffff','INR',1,'c3000000-0000-0000-0000-000000000002')
$sql$, '23503', 'invalid service offering version reference rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO service_offering_version_reservation_policies(id,service_offering_version_id,hold_seconds,created_by_account_id)
  VALUES ('c3000000-0000-0000-0000-00000000003e','c3000000-0000-0000-0000-00000000ffff',600,'c3000000-0000-0000-0000-000000000002')
$sql$, '23503', 'invalid reservation policy version reference rejected');
SELECT pg_temp.expect_sqlstate($sql$
  INSERT INTO slot_reservations(id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at)
  VALUES ('c3000000-0000-0000-0000-00000000003f','c3000000-0000-0000-0000-000000000032','c3000000-0000-0000-0000-000000000028','c3000000-0000-0000-0000-00000000ffff','2030-01-03T05:30Z','2030-01-03T06:00Z',1,'HELD',current_timestamp+interval '10 minutes')
$sql$, '23503', 'invalid reservation provider reference rejected');
DO $$ BEGIN RAISE NOTICE 'PASS: representative foreign keys enforced'; END $$;

-- RELEASED is explicit: it requires released_at and cannot be reactivated.
SELECT pg_temp.expect_sqlstate($sql$
  UPDATE slot_reservations SET status='RELEASED', released_at=NULL WHERE id='c3000000-0000-0000-0000-000000000031'
$sql$, '23514', 'released reservation requires released_at');
UPDATE slot_reservations SET status='RELEASED', released_at=current_timestamp WHERE id='c3000000-0000-0000-0000-000000000031';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM slot_reservations
    WHERE id='c3000000-0000-0000-0000-000000000031'
      AND status='RELEASED' AND released_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: reservation release was not represented';
  END IF;
  RAISE NOTICE 'PASS: released reservation state is represented correctly';
END $$;
SELECT pg_temp.expect_sqlstate($sql$
  UPDATE slot_reservations SET status='HELD', released_at=NULL WHERE id='c3000000-0000-0000-0000-000000000031'
$sql$, 'P0001', 'released reservation cannot reactivate');

DO $$ BEGIN RAISE NOTICE 'PASS: Phase 5 Step 3.1 database verification complete'; END $$;
ROLLBACK;
-- PASS: all deterministic fixture rows rolled back.

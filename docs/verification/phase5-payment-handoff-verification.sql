-- DISPOSABLE DEV VERIFICATION ONLY. Run with ON_ERROR_STOP against a fresh, fully migrated database.
-- This script creates no durable data: every fixture and assertion is inside BEGIN/ROLLBACK.
BEGIN;

DO $$ BEGIN
  IF to_regclass('appointment_financial_handoffs') IS NULL THEN RAISE EXCEPTION 'FAIL: appointment_financial_handoffs missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='appointment_intents'::regclass AND tgname='appointment_intent_payment_pending_integrity') THEN RAISE EXCEPTION 'FAIL: deferred payment-pending guard missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='financial_allocation_components'::regclass AND tgname='financial_allocation_components_immutable') THEN RAISE EXCEPTION 'FAIL: allocation component immutable guard missing'; END IF;
  RAISE NOTICE 'PASS: Phase 5 Step 4 schema and required database guards exist';
END $$;

INSERT INTO accounts (id,status) VALUES
  ('00000000-0000-4000-8000-000000001501','ACTIVE'),
  ('00000000-0000-4000-8000-000000001502','ACTIVE');
INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES
  ('00000000-0000-4000-8000-000000001503','00000000-0000-4000-8000-000000001501','ACTIVE','VERIFIED');
INSERT INTO patient_profiles (id,account_id,status) VALUES
  ('00000000-0000-4000-8000-000000001504','00000000-0000-4000-8000-000000001502','ACTIVE');
INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001505','00000000-0000-4000-8000-000000001503','Payment handoff offering','ACTIVE','00000000-0000-4000-8000-000000001501','00000000-0000-4000-8000-000000001501');
INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001506','00000000-0000-4000-8000-000000001505','00000000-0000-4000-8000-000000001503','DRAFT','00000000-0000-4000-8000-000000001501','00000000-0000-4000-8000-000000001501');
UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id='00000000-0000-4000-8000-000000001501' WHERE id='00000000-0000-4000-8000-000000001506';
INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001507','00000000-0000-4000-8000-000000001505',1,'ACTIVE',clock_timestamp()-interval '1 day','00000000-0000-4000-8000-000000001501');
INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001508','00000000-0000-4000-8000-000000001507','INR',10000,'00000000-0000-4000-8000-000000001501');
INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001509','00000000-0000-4000-8000-000000001507',600,'00000000-0000-4000-8000-000000001501');
INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES
  ('00000000-0000-4000-8000-000000001510','00000000-0000-4000-8000-000000001502','00000000-0000-4000-8000-000000001502','00000000-0000-4000-8000-000000001506','00000000-0000-4000-8000-000000001503','00000000-0000-4000-8000-000000001505','00000000-0000-4000-8000-000000001507','00000000-0000-4000-8000-000000001508','INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED','payment-handoff-fixture','fixture',clock_timestamp()+interval '10 minutes');
INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES
  ('00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001510','00000000-0000-4000-8000-000000001507','00000000-0000-4000-8000-000000001503',clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes');
INSERT INTO commercial_rules (id,status,rule_type,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001512','ACTIVE','FIXED','00000000-0000-4000-8000-000000001501');
INSERT INTO commercial_rule_versions (id,commercial_rule_id,version_number,status,priority,effective_from,calculation_basis,processing_fee_bearer,policy_data,approved_by_account_id,approved_at) VALUES
  ('00000000-0000-4000-8000-000000001513','00000000-0000-4000-8000-000000001512',1,'APPROVED',1,clock_timestamp()-interval '1 day','FIXED','THECLINIQ','{"fixedAmountMinor":500}'::jsonb,'00000000-0000-4000-8000-000000001501',clock_timestamp());
INSERT INTO commercial_rule_scopes (id,commercial_rule_version_id,scope_kind) VALUES
  ('00000000-0000-4000-8000-000000001514','00000000-0000-4000-8000-000000001513','GLOBAL');
INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001515','FINAL','INR',10000,'FIXED',jsonb_build_object('appointmentIntentId','00000000-0000-4000-8000-000000001510','slotReservationId','00000000-0000-4000-8000-000000001511','serviceExposureId','00000000-0000-4000-8000-000000001506','serviceOfferingId','00000000-0000-4000-8000-000000001505','serviceOfferingVersionId','00000000-0000-4000-8000-000000001507','serviceOfferingPriceId','00000000-0000-4000-8000-000000001508','patientAccountId','00000000-0000-4000-8000-000000001502','bookingActorAccountId','00000000-0000-4000-8000-000000001502','currency','INR','grossAmountMinor','10000'),jsonb_build_array('00000000-0000-4000-8000-000000001513'),'00000000-0000-4000-8000-000000001502');
INSERT INTO financial_allocation_components (id,allocation_snapshot_id,component_type,amount_minor,currency,rule_version_id) VALUES
  ('00000000-0000-4000-8000-000000001516','00000000-0000-4000-8000-000000001515','GROSS',10000,'INR',NULL),
  ('00000000-0000-4000-8000-000000001517','00000000-0000-4000-8000-000000001515','PLATFORM_COMMISSION',500,'INR','00000000-0000-4000-8000-000000001513'),
  ('00000000-0000-4000-8000-000000001518','00000000-0000-4000-8000-000000001515','PROVIDER_PAYABLE',9500,'INR','00000000-0000-4000-8000-000000001513');
INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000001519','RAZORPAY','CREATED','INR',10000,'00000000-0000-4000-8000-000000001515','payment-handoff-fixture','00000000-0000-4000-8000-000000001502');
INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES
  ('00000000-0000-4000-8000-000000001520','00000000-0000-4000-8000-000000001510','00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001515','00000000-0000-4000-8000-000000001519','00000000-0000-4000-8000-000000001502','handoff-fixture','fingerprint-fixture');
UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id='00000000-0000-4000-8000-000000001510';
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN RAISE NOTICE 'PASS: valid bridge and deferred PAYMENT_PENDING invariant accepted'; END $$;

DO $$ BEGIN
  BEGIN UPDATE financial_allocation_components SET amount_minor=1 WHERE id='00000000-0000-4000-8000-000000001516'; RAISE EXCEPTION 'FAIL: allocation component update accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: allocation component update accepted' THEN RAISE; END IF; END;
  BEGIN DELETE FROM financial_allocation_components WHERE id='00000000-0000-4000-8000-000000001516'; RAISE EXCEPTION 'FAIL: allocation component delete accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: allocation component delete accepted' THEN RAISE; END IF; END;
  BEGIN UPDATE appointment_financial_handoffs SET idempotency_key='changed' WHERE id='00000000-0000-4000-8000-000000001520'; RAISE EXCEPTION 'FAIL: bridge update accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: bridge update accepted' THEN RAISE; END IF; END;
  BEGIN UPDATE appointment_intents SET state='SLOT_RESERVED' WHERE id='00000000-0000-4000-8000-000000001510'; RAISE EXCEPTION 'FAIL: invalid payment transition accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: invalid payment transition accepted' THEN RAISE; END IF; END;
  BEGIN INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ('00000000-0000-4000-8000-000000001521','00000000-0000-4000-8000-000000001510','00000000-0000-4000-8000-000000001511','00000000-0000-4000-8000-000000001515','00000000-0000-4000-8000-000000001519','00000000-0000-4000-8000-000000001502','duplicate','duplicate'); RAISE EXCEPTION 'FAIL: duplicate bridge accepted'; EXCEPTION WHEN others THEN IF SQLERRM='FAIL: duplicate bridge accepted' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS: bridge, component, uniqueness, and state-transition tampering rejected';
END $$;

ROLLBACK;
-- PASS: all Phase 5 Step 4 verification fixtures rolled back.

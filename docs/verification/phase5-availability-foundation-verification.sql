-- DISPOSABLE DEV VERIFICATION ONLY. Run after all migrations are UP.
-- All fixtures use deterministic IDs and are removed by the final ROLLBACK.
BEGIN;

DO $$
BEGIN
  IF to_regclass('availability_configurations') IS NULL OR to_regclass('availability_rules') IS NULL OR to_regclass('availability_windows') IS NULL OR to_regclass('availability_exceptions') IS NULL THEN RAISE EXCEPTION 'FAIL: Phase 5 Step 2 tables missing'; END IF;
  IF to_regprocedure('availability_derive_utc(text,timestamp)') IS NULL OR to_regprocedure('availability_exception_derived_guard()') IS NULL THEN RAISE EXCEPTION 'FAIL: UTC derivation objects missing'; END IF;
  RAISE NOTICE 'PASS: Availability schema, UTC function, and trigger exist';
END $$;

INSERT INTO accounts (id, status, display_name) VALUES ('a5000000-0000-0000-0000-000000000001', 'ACTIVE', 'Availability verification');
INSERT INTO doctor_profiles (id, account_id, status, display_name, professional_verification_status) VALUES ('a5000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000001', 'ACTIVE', 'Verification doctor', 'VERIFIED');
INSERT INTO service_offerings (id, owner_doctor_profile_id, name, status, created_by_account_id, updated_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-000000000002', 'Availability verification offering', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001');
INSERT INTO service_offering_versions (id, service_offering_id, version_number, status, effective_from, effective_to, created_by_account_id) VALUES
  ('a5000000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-000000000003', 1, 'ACTIVE', '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z', 'a5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000005', 'a5000000-0000-0000-0000-000000000003', 2, 'ACTIVE', '2027-02-01T00:00:00Z', '2027-03-01T00:00:00Z', 'a5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000006', 'a5000000-0000-0000-0000-000000000003', 3, 'ACTIVE', '2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z', 'a5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000007', 'a5000000-0000-0000-0000-000000000003', 4, 'ACTIVE', '2027-04-01T00:00:00Z', '2027-05-01T00:00:00Z', 'a5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000008', 'a5000000-0000-0000-0000-000000000003', 5, 'ACTIVE', '2027-05-01T00:00:00Z', NULL, 'a5000000-0000-0000-0000-000000000001');
INSERT INTO availability_configurations (id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000010', 'a5000000-0000-0000-0000-000000000004', 'America/New_York', 1800, 0, 0, 1, 0, 86400, 'ACTIVE', 'a5000000-0000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN INSERT INTO availability_configurations (id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000011', 'a5000000-0000-0000-0000-000000000005', 'America/New_York', 0, 0, 0, 1, 0, 1, 'ACTIVE', 'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: zero slot duration accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO availability_configurations (id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000012', 'a5000000-0000-0000-0000-000000000006', 'America/New_York', 1, -1, 0, 1, 0, 1, 'ACTIVE', 'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: negative buffer accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO availability_configurations (id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000013', 'a5000000-0000-0000-0000-000000000007', 'America/New_York', 1, 0, 0, 0, 0, 1, 'ACTIVE', 'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: zero capacity accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO availability_configurations (id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000014', 'a5000000-0000-0000-0000-000000000008', 'America/New_York', 1, 0, 0, 1, 10, 10, 'ACTIVE', 'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: invalid horizon accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM availability_derive_utc('Invalid/Timezone', '2027-01-01 10:00:00'); RAISE EXCEPTION 'FAIL: invalid IANA timezone accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  RAISE NOTICE 'PASS: Configuration checks and invalid IANA timezone rejection';
END $$;

INSERT INTO availability_rules (id, availability_configuration_id, canonical_recurrence, recurrence_identity, effective_from, effective_to, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000020', 'a5000000-0000-0000-0000-000000000010', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO', '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001');
DO $$
BEGIN
  BEGIN INSERT INTO availability_rules (id, availability_configuration_id, canonical_recurrence, recurrence_identity, effective_from, effective_to, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000021', 'a5000000-0000-0000-0000-000000000010', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO', '2027-01-15T00:00:00Z', '2027-02-15T00:00:00Z', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: overlapping recurrence accepted'; EXCEPTION WHEN exclusion_violation THEN NULL; END;
  INSERT INTO availability_rules (id, availability_configuration_id, canonical_recurrence, recurrence_identity, effective_from, effective_to, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000022', 'a5000000-0000-0000-0000-000000000010', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO', '2027-02-01T00:00:00Z', '2027-03-01T00:00:00Z', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001');
  INSERT INTO availability_rules (id, availability_configuration_id, canonical_recurrence, recurrence_identity, effective_from, effective_to, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000023', 'a5000000-0000-0000-0000-000000000010', 'FREQ=WEEKLY;BYDAY=TU', 'FREQ=WEEKLY;BYDAY=TU', '2027-01-15T00:00:00Z', '2027-02-15T00:00:00Z', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001');
  RAISE NOTICE 'PASS: Canonical recurrence identity overlap, adjacency, and difference checks';
END $$;

INSERT INTO availability_windows (id, availability_rule_id, kind, weekday, start_seconds, end_seconds, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000030', 'a5000000-0000-0000-0000-000000000020', 'WORKING', 1, 32400, 43200, 'a5000000-0000-0000-0000-000000000001');
DO $$
BEGIN
  BEGIN INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000031','a5000000-0000-0000-0000-000000000020','WORKING',1,40000,45000,'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: overlapping working window accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000032','a5000000-0000-0000-0000-000000000020','WORKING',1,43200,46800,'a5000000-0000-0000-0000-000000000001');
  INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000033','a5000000-0000-0000-0000-000000000020','BREAK',1,36000,37800,'a5000000-0000-0000-0000-000000000001');
  BEGIN INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000034','a5000000-0000-0000-0000-000000000020','BREAK',1,37000,38000,'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: overlapping break accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000035','a5000000-0000-0000-0000-000000000020','BREAK',1,37800,39000,'a5000000-0000-0000-0000-000000000001');
  BEGIN INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000036','a5000000-0000-0000-0000-000000000020','BREAK',1,1000,2000,'a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: uncontained break accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  RAISE NOTICE 'PASS: Working/break overlap, adjacency, and containment checks';
END $$;

INSERT INTO availability_exceptions (id, availability_configuration_id, kind, local_start, local_end, derived_start_utc, derived_end_utc, status, created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000040', 'a5000000-0000-0000-0000-000000000010', 'HOLIDAY', '2027-01-10 10:00:00', '2027-01-10 11:00:00', '2000-01-01T00:00:00Z', '2000-01-01T01:00:00Z', 'ACTIVE', 'a5000000-0000-0000-0000-000000000001');
DO $$
DECLARE derived_start timestamptz; derived_end timestamptz;
BEGIN
  SELECT derived_start_utc, derived_end_utc INTO derived_start, derived_end FROM availability_exceptions WHERE id='a5000000-0000-0000-0000-000000000040';
  IF derived_start <> availability_derive_utc('America/New_York', '2027-01-10 10:00:00') OR derived_end <> availability_derive_utc('America/New_York', '2027-01-10 11:00:00') OR derived_start = '2000-01-01T00:00:00Z' THEN RAISE EXCEPTION 'FAIL: local/UTC derivation diverged'; END IF;
  BEGIN INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000041','a5000000-0000-0000-0000-000000000010','LEAVE','2027-03-14 02:30:00','2027-03-14 03:30:00',now(),now()+interval '1 hour','ACTIVE','a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: spring-forward nonexistent time accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000042','a5000000-0000-0000-0000-000000000010','LEAVE','2027-11-07 01:30:00','2027-11-07 02:30:00',now(),now()+interval '1 hour','ACTIVE','a5000000-0000-0000-0000-000000000001');
  IF (SELECT derived_start_utc FROM availability_exceptions WHERE id='a5000000-0000-0000-0000-000000000042') <> '2027-11-07T05:30:00Z' THEN RAISE EXCEPTION 'FAIL: fall-back did not choose earlier occurrence'; END IF;
  BEGIN INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000043','a5000000-0000-0000-0000-000000000010','ONE_OFF','2020-01-01 10:00:00','2020-01-01 11:00:00',now(),now()+interval '1 hour','ACTIVE','a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: past one-off accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000044','a5000000-0000-0000-0000-000000000010','ONE_OFF','2030-01-01 10:00:00','2030-01-01 11:00:00',now(),now()+interval '1 hour','ACTIVE','a5000000-0000-0000-0000-000000000001');
  BEGIN INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ('a5000000-0000-0000-0000-000000000045','a5000000-0000-0000-0000-000000000010','HOLIDAY','2027-01-10 10:30:00','2027-01-10 11:30:00',now(),now()+interval '1 hour','ACTIVE','a5000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: same-precedence conflict accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
  RAISE NOTICE 'PASS: exception local/UTC guard, DST, one-off, and conflict checks';
END $$;

DO $$ BEGIN RAISE NOTICE 'PASS: Step 2 remains configuration-only; no reservation behavior is asserted or introduced'; END $$;
ROLLBACK;

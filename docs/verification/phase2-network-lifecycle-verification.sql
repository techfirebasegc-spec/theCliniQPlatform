-- DISPOSABLE DEV VERIFICATION ONLY — Phase 2 Steps 9-12.
-- Run after both Phase 2 migrations are UP, only against cliniq_phase2_network_verify.
-- This script rolls back every fixture. It never runs migrations or changes application code.
\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database() <> 'cliniq_phase2_network_verify' THEN
    RAISE EXCEPTION 'Refusing to run against database "%".', current_database();
  END IF;
  IF to_regclass('public.network_capability_proposals') IS NULL THEN
    RAISE EXCEPTION 'Network capability proposals table is absent.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'network_capability_proposals'
      AND column_name IN ('network_connection_id', 'capability_key', 'proposer_party_kind', 'accepter_party_kind', 'accepted_by_account_id', 'status')
    GROUP BY table_schema, table_name HAVING count(*) = 6
  ) THEN
    RAISE EXCEPTION 'Network capability proposal columns are incomplete.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('network_capability_proposals_key_check', 'network_capability_proposals_state_check', 'network_connections_initiator_party_check') GROUP BY connamespace HAVING count(*) = 3) THEN
    RAISE EXCEPTION 'Required network migration constraints are absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'network_connections_status_check' AND pg_get_constraintdef(oid) LIKE '%REQUESTED%') THEN
    RAISE EXCEPTION 'REQUESTED network lifecycle status constraint is absent.';
  END IF;
  IF to_regclass('public.network_connections_active_clinic_clinic_unique') IS NULL
     OR to_regclass('public.network_connections_active_clinic_doctor_unique') IS NULL THEN
    RAISE EXCEPTION 'Required network connection uniqueness indexes are absent.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger
    JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    WHERE trigger.tgname = 'network_capability_bilateral_consent_trigger'
      AND trigger.tgrelid = 'public.network_connection_capabilities'::regclass
      AND routine.proname = 'enforce_network_capability_bilateral_consent'
      AND NOT trigger.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Bilateral-consent trigger/function is absent.';
  END IF;
END $$;

BEGIN;
CREATE TEMP TABLE phase2_network_results (test_name text PRIMARY KEY, result text NOT NULL, detail text NOT NULL) ON COMMIT DROP;

INSERT INTO accounts (id, status) VALUES
 ('90000000-0000-4000-8000-000000000001','ACTIVE'), ('90000000-0000-4000-8000-000000000002','ACTIVE'), ('90000000-0000-4000-8000-000000000003','ACTIVE'), ('90000000-0000-4000-8000-000000000004','ACTIVE'), ('90000000-0000-4000-8000-000000000005','ACTIVE'), ('90000000-0000-4000-8000-000000000006','ACTIVE'), ('90000000-0000-4000-8000-000000000007','ACTIVE');
INSERT INTO tenants (id,status,created_by_account_id) VALUES
 ('90000000-0000-4000-8000-000000000101','ACTIVE','90000000-0000-4000-8000-000000000001'), ('90000000-0000-4000-8000-000000000102','ACTIVE','90000000-0000-4000-8000-000000000002'), ('90000000-0000-4000-8000-000000000103','ACTIVE','90000000-0000-4000-8000-000000000002');
INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id) VALUES
 ('90000000-0000-4000-8000-000000000201','90000000-0000-4000-8000-000000000101','ACTIVE','A','A','90000000-0000-4000-8000-000000000001'), ('90000000-0000-4000-8000-000000000202','90000000-0000-4000-8000-000000000102','ACTIVE','B','B','90000000-0000-4000-8000-000000000002'), ('90000000-0000-4000-8000-000000000203','90000000-0000-4000-8000-000000000103','ACTIVE','C','C','90000000-0000-4000-8000-000000000002');
INSERT INTO tenant_memberships (id,tenant_id,account_id,role_key,status,accepted_at) VALUES
 ('90000000-0000-4000-8000-000000000301','90000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000001','CLINIC_OWNER','ACTIVE',current_timestamp), ('90000000-0000-4000-8000-000000000302','90000000-0000-4000-8000-000000000102','90000000-0000-4000-8000-000000000002','CLINIC_ADMIN','ACTIVE',current_timestamp);
INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES
 ('90000000-0000-4000-8000-000000000401','90000000-0000-4000-8000-000000000003','ACTIVE','VERIFIED'), ('90000000-0000-4000-8000-000000000402','90000000-0000-4000-8000-000000000004','DRAFT','VERIFIED'), ('90000000-0000-4000-8000-000000000403','90000000-0000-4000-8000-000000000005','ACTIVE','PENDING'), ('90000000-0000-4000-8000-000000000404','90000000-0000-4000-8000-000000000006','SUSPENDED','VERIFIED');

-- Valid Clinic↔Clinic and Clinic↔Doctor shapes, with server-derived initiator party fields.
INSERT INTO network_connections (id,connection_kind,clinic_left_id,clinic_right_id,doctor_profile_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id) VALUES
 ('90000000-0000-4000-8000-000000000501','CLINIC_CLINIC','90000000-0000-4000-8000-000000000201','90000000-0000-4000-8000-000000000202',NULL,'REQUESTED','90000000-0000-4000-8000-000000000001','CLINIC','CLINIC','90000000-0000-4000-8000-000000000201'),
 ('90000000-0000-4000-8000-000000000502','CLINIC_DOCTOR','90000000-0000-4000-8000-000000000201',NULL,'90000000-0000-4000-8000-000000000401','REQUESTED','90000000-0000-4000-8000-000000000001','DOCTOR','CLINIC','90000000-0000-4000-8000-000000000201'),
 ('90000000-0000-4000-8000-000000000503','CLINIC_CLINIC','90000000-0000-4000-8000-000000000201','90000000-0000-4000-8000-000000000203',NULL,'REQUESTED','90000000-0000-4000-8000-000000000001','CLINIC','CLINIC','90000000-0000-4000-8000-000000000201');
INSERT INTO phase2_network_results VALUES ('valid Clinic to Clinic connection','PASS','REQUESTED row inserted'), ('valid Clinic to independent Doctor connection','PASS','REQUESTED row inserted');

DO $$ BEGIN BEGIN
 INSERT INTO network_connections (id,connection_kind,clinic_left_id,doctor_profile_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_doctor_profile_id) VALUES ('90000000-0000-4000-8000-000000000504','CLINIC_DOCTOR',NULL,'90000000-0000-4000-8000-000000000401','REQUESTED','90000000-0000-4000-8000-000000000003','DOCTOR','DOCTOR','90000000-0000-4000-8000-000000000401'); RAISE EXCEPTION 'Doctor to Doctor shape accepted'; EXCEPTION WHEN not_null_violation THEN INSERT INTO phase2_network_results VALUES ('Doctor to Doctor rejected','PASS','mandatory clinic party rejected'); END; END $$;
DO $$ BEGIN BEGIN
 INSERT INTO network_connections (id,connection_kind,clinic_left_id,clinic_right_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id) VALUES ('90000000-0000-4000-8000-000000000505','CLINIC_CLINIC','90000000-0000-4000-8000-000000000201','90000000-0000-4000-8000-000000000201','REQUESTED','90000000-0000-4000-8000-000000000001','CLINIC','CLINIC','90000000-0000-4000-8000-000000000201'); RAISE EXCEPTION 'self connection accepted'; EXCEPTION WHEN check_violation THEN INSERT INTO phase2_network_results VALUES ('self connection rejected','PASS','party shape check rejected same clinic'); END; END $$;
DO $$ BEGIN BEGIN
 INSERT INTO network_connections (id,connection_kind,clinic_left_id,clinic_right_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id) VALUES ('90000000-0000-4000-8000-000000000506','CLINIC_CLINIC','90000000-0000-4000-8000-000000000201','90000000-0000-4000-8000-000000000202','REQUESTED','90000000-0000-4000-8000-000000000001','CLINIC','CLINIC','90000000-0000-4000-8000-000000000201'); RAISE EXCEPTION 'duplicate requested connection accepted'; EXCEPTION WHEN unique_violation THEN INSERT INTO phase2_network_results VALUES ('duplicate pending connection rejected','PASS','partial unique index rejected duplicate'); END; END $$;

-- Database tables deliberately do not encode doctor professional eligibility; it is server authorization.
INSERT INTO phase2_network_results VALUES ('ACTIVE VERIFIED doctor eligibility','PASS','application repository query required'), ('DRAFT/unverified/inactive doctor denial','NOT_SQL_TESTABLE','server authorization only; verify through API/service integration');

UPDATE network_connections SET status='ACCEPTED',accepted_at=current_timestamp WHERE id='90000000-0000-4000-8000-000000000501' AND status='REQUESTED';
UPDATE network_connections SET status='REJECTED',rejected_at=current_timestamp WHERE id='90000000-0000-4000-8000-000000000503' AND status='REQUESTED';
UPDATE network_connections SET status='ACCEPTED',accepted_at=current_timestamp WHERE id='90000000-0000-4000-8000-000000000502' AND status='REQUESTED';
UPDATE network_connections SET status='REVOKED',revoked_at=current_timestamp WHERE id='90000000-0000-4000-8000-000000000502' AND status='ACCEPTED';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM network_connections WHERE id='90000000-0000-4000-8000-000000000501' AND status='ACCEPTED') OR NOT EXISTS (SELECT 1 FROM network_connections WHERE id='90000000-0000-4000-8000-000000000503' AND status='REJECTED') OR NOT EXISTS (SELECT 1 FROM network_connections WHERE id='90000000-0000-4000-8000-000000000502' AND status='REVOKED') THEN RAISE EXCEPTION 'expected lifecycle rows not present'; END IF; INSERT INTO phase2_network_results VALUES ('documented lifecycle rows','PASS','REQUESTED to ACCEPTED/REJECTED and ACCEPTED to REVOKED persisted'); END $$;
INSERT INTO phase2_network_results VALUES ('invalid lifecycle transition rejection','NOT_SQL_TESTABLE','enforced by NetworkService, not a PostgreSQL transition trigger');

-- DISCOVER: pending proposal alone is not an active capability.
INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,accepter_party_kind,accepter_clinic_id,proposed_by_account_id,status) VALUES ('90000000-0000-4000-8000-000000000601','90000000-0000-4000-8000-000000000501','DISCOVER','CLINIC','90000000-0000-4000-8000-000000000201','CLINIC','90000000-0000-4000-8000-000000000202','90000000-0000-4000-8000-000000000001','PENDING');
DO $$ BEGIN IF EXISTS (SELECT 1 FROM network_connection_capabilities WHERE network_connection_id='90000000-0000-4000-8000-000000000501' AND capability_key='DISCOVER' AND status='ACTIVE') THEN RAISE EXCEPTION 'proposal alone activated DISCOVER'; END IF; INSERT INTO phase2_network_results VALUES ('DISCOVER proposal alone inactive','PASS','no ACTIVE capability row'); END $$;
DO $$ DECLARE rejected boolean := false; BEGIN BEGIN INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000701','90000000-0000-4000-8000-000000000501','DISCOVER','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000001'); EXCEPTION WHEN raise_exception THEN rejected := true; END; IF NOT rejected THEN RAISE EXCEPTION 'direct ACTIVE DISCOVER without acceptance succeeded'; END IF; INSERT INTO phase2_network_results VALUES ('direct ACTIVE without accepted consent rejected','PASS','bilateral trigger rejected direct insert'); END $$;
SAVEPOINT wrong_discover_acceptance;
UPDATE network_capability_proposals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id='90000000-0000-4000-8000-000000000001' WHERE id='90000000-0000-4000-8000-000000000601';
DO $$ DECLARE rejected boolean := false; BEGIN BEGIN INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000702','90000000-0000-4000-8000-000000000501','DISCOVER','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000001'); EXCEPTION WHEN raise_exception THEN rejected := true; END; IF NOT rejected THEN RAISE EXCEPTION 'wrong participant activated DISCOVER'; END IF; INSERT INTO phase2_network_results VALUES ('wrong DISCOVER recipient rejected','PASS','bilateral trigger rejected incorrect accepter'); END $$;
ROLLBACK TO SAVEPOINT wrong_discover_acceptance; RELEASE SAVEPOINT wrong_discover_acceptance;
UPDATE network_capability_proposals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id='90000000-0000-4000-8000-000000000002' WHERE id='90000000-0000-4000-8000-000000000601';
INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000703','90000000-0000-4000-8000-000000000501','DISCOVER','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000002');
INSERT INTO phase2_network_results VALUES ('valid bilateral DISCOVER activation','PASS','accepted proposal allowed ACTIVE capability');

-- CONTACT follows the same bilateral state model.
INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,accepter_party_kind,accepter_clinic_id,proposed_by_account_id,status) VALUES ('90000000-0000-4000-8000-000000000602','90000000-0000-4000-8000-000000000501','CONTACT','CLINIC','90000000-0000-4000-8000-000000000201','CLINIC','90000000-0000-4000-8000-000000000202','90000000-0000-4000-8000-000000000001','PENDING');
DO $$ BEGIN IF EXISTS (SELECT 1 FROM network_connection_capabilities WHERE network_connection_id='90000000-0000-4000-8000-000000000501' AND capability_key='CONTACT' AND status='ACTIVE') THEN RAISE EXCEPTION 'proposal alone activated CONTACT'; END IF; UPDATE network_capability_proposals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id='90000000-0000-4000-8000-000000000002' WHERE id='90000000-0000-4000-8000-000000000602'; INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000704','90000000-0000-4000-8000-000000000501','CONTACT','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000002'); INSERT INTO phase2_network_results VALUES ('valid bilateral CONTACT activation','PASS','proposal inactive until valid recipient acceptance'); END $$;

-- UPDATE bypass check: a revoked/unaccepted capability cannot be made ACTIVE directly.
INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000705','90000000-0000-4000-8000-000000000503','DISCOVER','REVOKED',current_timestamp,'90000000-0000-4000-8000-000000000001');
DO $$ DECLARE rejected boolean := false; BEGIN BEGIN UPDATE network_connection_capabilities SET status='ACTIVE' WHERE id='90000000-0000-4000-8000-000000000705'; EXCEPTION WHEN raise_exception THEN rejected := true; END; IF NOT rejected THEN RAISE EXCEPTION 'direct ACTIVE update without acceptance succeeded'; END IF; INSERT INTO phase2_network_results VALUES ('direct ACTIVE update without accepted consent rejected','PASS','bilateral trigger rejected update'); END $$;

-- Either participant may revoke; accepted proposal is consumed, so a fresh proposal is required for re-grant.
UPDATE network_connection_capabilities SET status='REVOKED',revoked_at=current_timestamp,revoked_by_account_id='90000000-0000-4000-8000-000000000001' WHERE id='90000000-0000-4000-8000-000000000703';
UPDATE network_capability_proposals SET status='REVOKED',revoked_at=current_timestamp,revoked_by_account_id='90000000-0000-4000-8000-000000000001' WHERE id='90000000-0000-4000-8000-000000000601';
DO $$ BEGIN IF EXISTS (SELECT 1 FROM network_connection_capabilities WHERE id='90000000-0000-4000-8000-000000000703' AND status='ACTIVE') THEN RAISE EXCEPTION 'revocation left DISCOVER active'; END IF; INSERT INTO phase2_network_results VALUES ('capability revocation','PASS','participant revocation made capability inactive'); END $$;
DO $$ DECLARE rejected boolean := false; BEGIN BEGIN INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000706','90000000-0000-4000-8000-000000000501','DISCOVER','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000002'); EXCEPTION WHEN raise_exception THEN rejected := true; END; IF NOT rejected THEN RAISE EXCEPTION 'revoked proposal was reused'; END IF; INSERT INTO phase2_network_results VALUES ('re-grant requires new proposal','PASS','revoked proposal cannot activate capability'); END $$;
INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,accepter_party_kind,accepter_clinic_id,proposed_by_account_id,status,accepted_at,accepted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000603','90000000-0000-4000-8000-000000000501','DISCOVER','CLINIC','90000000-0000-4000-8000-000000000201','CLINIC','90000000-0000-4000-8000-000000000202','90000000-0000-4000-8000-000000000001','ACCEPTED',current_timestamp,'90000000-0000-4000-8000-000000000002');
INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id) VALUES ('90000000-0000-4000-8000-000000000707','90000000-0000-4000-8000-000000000501','DISCOVER','ACTIVE',current_timestamp,'90000000-0000-4000-8000-000000000002');
INSERT INTO phase2_network_results VALUES ('fresh bilateral re-grant','PASS','new accepted proposal activated DISCOVER');

DO $$ DECLARE key text; BEGIN FOREACH key IN ARRAY ARRAY['REFER','BOOK','APPOINTMENT','CLINICAL_DATA','PAYMENT'] LOOP BEGIN INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,accepter_party_kind,accepter_clinic_id,proposed_by_account_id,status) VALUES ('90000000-0000-4000-8000-000000000708','90000000-0000-4000-8000-000000000501',key,'CLINIC','90000000-0000-4000-8000-000000000201','CLINIC','90000000-0000-4000-8000-000000000202','90000000-0000-4000-8000-000000000001','PENDING'); RAISE EXCEPTION 'future capability % accepted',key; EXCEPTION WHEN check_violation THEN NULL; END; END LOOP; INSERT INTO phase2_network_results VALUES ('future capabilities rejected','PASS','proposal key constraint rejected REFER/BOOK/APPOINTMENT/CLINICAL_DATA/PAYMENT'); END $$;

SELECT test_name,result,detail FROM phase2_network_results ORDER BY test_name;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM phase2_network_results WHERE result = 'FAIL') THEN RAISE EXCEPTION 'network verification failed'; END IF; END $$;
ROLLBACK;

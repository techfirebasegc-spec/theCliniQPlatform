-- theCliniQ Phase 2 foundation negative PostgreSQL verification.
-- Run only against the disposable cliniq_phase2_verify database.
-- This script creates transaction-scoped temporary records and rolls them back.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cliniq_phase2_verify' THEN
    RAISE EXCEPTION 'Refusing to run against database "%".', current_database();
  END IF;
END;
$$;

BEGIN;

CREATE TEMP TABLE phase2_foundation_verification_results (
  test_name text PRIMARY KEY,
  result text NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  detail text NOT NULL
) ON COMMIT DROP;

-- Baseline records. All identifiers are transaction-local test fixtures.
INSERT INTO accounts (id, status) VALUES
  ('00000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('00000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('00000000-0000-4000-8000-000000000003', 'ACTIVE');

INSERT INTO authentication_identities (
  id, account_id, provider, provider_subject, status, verified_at, linked_at
) VALUES (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'firebase_google',
  'phase2-verification-identity',
  'LINKED',
  current_timestamp,
  current_timestamp
);

INSERT INTO patient_profiles (id, account_id, status) VALUES (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000001',
  'ACTIVE'
);

INSERT INTO doctor_profiles (
  id, account_id, status, professional_verification_status
) VALUES (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000001',
  'ACTIVE',
  'VERIFIED'
);

INSERT INTO tenants (id, status, created_by_account_id) VALUES
  ('00000000-0000-4000-8000-000000000401', 'ACTIVE', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000402', 'ACTIVE', '00000000-0000-4000-8000-000000000001');

INSERT INTO clinics (
  id, tenant_id, status, legal_name, display_name, created_by_account_id
) VALUES
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000401', 'ACTIVE', 'Phase 2 Clinic One', 'Phase 2 Clinic One', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000402', 'ACTIVE', 'Phase 2 Clinic Two', 'Phase 2 Clinic Two', '00000000-0000-4000-8000-000000000001');

INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status) VALUES (
  '00000000-0000-4000-8000-000000000601',
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000002',
  'CLINIC_STAFF',
  'ACTIVE'
);

INSERT INTO network_connections (
  id, connection_kind, clinic_left_id, clinic_right_id, doctor_profile_id,
  status, initiated_by_account_id, recipient_party_kind
) VALUES (
  '00000000-0000-4000-8000-000000000701',
  'CLINIC_CLINIC',
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000502',
  NULL,
  'ACCEPTED',
  '00000000-0000-4000-8000-000000000001',
  'CLINIC'
);

-- 1. Duplicate provider + provider_subject must fail.
SAVEPOINT duplicate_authentication_identity;
DO $$
BEGIN
  BEGIN
    INSERT INTO authentication_identities (id, account_id, provider, provider_subject, status, verified_at, linked_at)
    VALUES ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 'firebase_google', 'phase2-verification-identity', 'LINKED', current_timestamp, current_timestamp);
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate authentication identity', 'FAIL', 'duplicate provider and subject were accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate authentication identity', 'PASS', 'unique provider and subject constraint rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate authentication identity', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_authentication_identity;

-- 2. One PatientProfile per Account.
SAVEPOINT duplicate_patient_profile;
DO $$
BEGIN
  BEGIN
    INSERT INTO patient_profiles (id, account_id, status)
    VALUES ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', 'ACTIVE');
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate patient profile', 'FAIL', 'duplicate profile was accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate patient profile', 'PASS', 'unique account constraint rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate patient profile', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_patient_profile;

-- 3. One DoctorProfile per Account.
SAVEPOINT duplicate_doctor_profile;
DO $$
BEGIN
  BEGIN
    INSERT INTO doctor_profiles (id, account_id, status, professional_verification_status)
    VALUES ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', 'ACTIVE', 'VERIFIED');
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate doctor profile', 'FAIL', 'duplicate profile was accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate doctor profile', 'PASS', 'unique account constraint rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate doctor profile', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_doctor_profile;

-- 4. One operational Clinic per Tenant.
SAVEPOINT duplicate_clinic;
DO $$
BEGIN
  BEGIN
    INSERT INTO clinics (id, tenant_id, status, legal_name, display_name, created_by_account_id)
    VALUES ('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000401', 'ACTIVE', 'Duplicate Clinic', 'Duplicate Clinic', '00000000-0000-4000-8000-000000000001');
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate clinic tenant', 'FAIL', 'duplicate tenant and clinic relation was accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate clinic tenant', 'PASS', 'unique tenant constraint rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate clinic tenant', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_clinic;

-- 5. An Account cannot have another active or invited membership in the same Tenant.
SAVEPOINT duplicate_active_membership;
DO $$
BEGIN
  BEGIN
    INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status)
    VALUES ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000002', 'CLINIC_STAFF', 'INVITED');
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active or invited membership', 'FAIL', 'duplicate membership was accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active or invited membership', 'PASS', 'partial unique index rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active or invited membership', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_active_membership;

-- 6. A Doctor-to-Doctor connection cannot be represented because clinic_left_id is mandatory.
SAVEPOINT doctor_to_doctor_connection;
DO $$
BEGIN
  BEGIN
    INSERT INTO network_connections (id, connection_kind, clinic_left_id, clinic_right_id, doctor_profile_id, status, initiated_by_account_id, recipient_party_kind)
    VALUES ('00000000-0000-4000-8000-000000000702', 'CLINIC_DOCTOR', NULL, NULL, '00000000-0000-4000-8000-000000000301', 'PENDING', '00000000-0000-4000-8000-000000000001', 'DOCTOR');
    INSERT INTO phase2_foundation_verification_results VALUES ('doctor to doctor connection', 'FAIL', 'doctor-only connection was accepted');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('doctor to doctor connection', 'PASS', 'mandatory clinic party rejected doctor-only connection');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('doctor to doctor connection', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT doctor_to_doctor_connection;

-- 7. A Clinic-to-Clinic connection cannot contain a Doctor party.
SAVEPOINT invalid_network_party_shape;
DO $$
BEGIN
  BEGIN
    INSERT INTO network_connections (id, connection_kind, clinic_left_id, clinic_right_id, doctor_profile_id, status, initiated_by_account_id, recipient_party_kind)
    VALUES ('00000000-0000-4000-8000-000000000703', 'CLINIC_CLINIC', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000301', 'PENDING', '00000000-0000-4000-8000-000000000001', 'CLINIC');
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid network party shape', 'FAIL', 'invalid party shape was accepted');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid network party shape', 'PASS', 'network shape check rejected invalid parties');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid network party shape', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT invalid_network_party_shape;

-- 8. Only DISCOVER and CONTACT are allowed capability keys.
SAVEPOINT unsupported_capability;
DO $$
BEGIN
  BEGIN
    INSERT INTO network_connection_capabilities (id, network_connection_id, capability_key, status, granted_at, granted_by_account_id)
    VALUES ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701', 'REFER', 'ACTIVE', current_timestamp, '00000000-0000-4000-8000-000000000001');
    INSERT INTO phase2_foundation_verification_results VALUES ('unsupported capability', 'FAIL', 'unsupported capability was accepted');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('unsupported capability', 'PASS', 'capability check rejected unsupported value');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('unsupported capability', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT unsupported_capability;

INSERT INTO network_connection_capabilities (id, network_connection_id, capability_key, status, granted_at, granted_by_account_id)
VALUES ('00000000-0000-4000-8000-000000000802', '00000000-0000-4000-8000-000000000701', 'DISCOVER', 'ACTIVE', current_timestamp, '00000000-0000-4000-8000-000000000001');

-- 9. A connection cannot hold two active records for the same capability.
SAVEPOINT duplicate_active_capability;
DO $$
BEGIN
  BEGIN
    INSERT INTO network_connection_capabilities (id, network_connection_id, capability_key, status, granted_at, granted_by_account_id)
    VALUES ('00000000-0000-4000-8000-000000000803', '00000000-0000-4000-8000-000000000701', 'DISCOVER', 'ACTIVE', current_timestamp, '00000000-0000-4000-8000-000000000001');
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active capability', 'FAIL', 'duplicate active capability was accepted');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active capability', 'PASS', 'partial unique index rejected duplicate');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('duplicate active capability', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT duplicate_active_capability;

-- 10. A session absolute expiry must be after creation.
SAVEPOINT invalid_absolute_session_expiry;
DO $$
BEGIN
  BEGIN
    INSERT INTO sessions (id, account_id, secret_hash, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000001', 'phase2-invalid-absolute-expiry', 'ACTIVE', current_timestamp, current_timestamp, current_timestamp, current_timestamp - interval '1 second');
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session absolute expiry', 'FAIL', 'invalid absolute expiry was accepted');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session absolute expiry', 'PASS', 'absolute expiry check rejected invalid value');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session absolute expiry', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT invalid_absolute_session_expiry;

-- 11. A session idle expiry cannot exceed its absolute expiry.
SAVEPOINT invalid_idle_session_expiry;
DO $$
BEGIN
  BEGIN
    INSERT INTO sessions (id, account_id, secret_hash, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000001', 'phase2-invalid-idle-expiry', 'ACTIVE', current_timestamp, current_timestamp, current_timestamp + interval '2 hours', current_timestamp + interval '1 hour');
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session idle expiry', 'FAIL', 'invalid idle expiry was accepted');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session idle expiry', 'PASS', 'idle expiry check rejected invalid value');
  WHEN OTHERS THEN
    INSERT INTO phase2_foundation_verification_results VALUES ('invalid session idle expiry', 'FAIL', SQLSTATE || ': ' || SQLERRM);
  END;
END;
$$;
RELEASE SAVEPOINT invalid_idle_session_expiry;

SELECT test_name, result, detail
FROM phase2_foundation_verification_results
ORDER BY test_name;

SELECT CASE WHEN bool_and(result = 'PASS') THEN 'PASS' ELSE 'FAIL' END AS overall_result
FROM phase2_foundation_verification_results;

-- Removes every fixture and the temporary result table without touching schema.
ROLLBACK;

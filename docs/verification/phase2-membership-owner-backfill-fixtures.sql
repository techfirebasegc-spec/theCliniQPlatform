-- DISPOSABLE DEV VERIFICATION ONLY.
-- Target: cliniq_phase2_membership_verify after foundation UP and membership migration DOWN.
-- Run exactly one phase per invocation; see the verification commands in the accompanying review.

\if :{?seed_success}
\echo 'Seeding Cases A, B, and C in foundation state'
BEGIN;
INSERT INTO accounts (id, status, display_name) VALUES
  ('10000000-0000-0000-0000-000000000001', 'ACTIVE', 'verify-a-creator'),
  ('10000000-0000-0000-0000-000000000002', 'ACTIVE', 'verify-b-creator'),
  ('10000000-0000-0000-0000-000000000003', 'ACTIVE', 'verify-c-creator'),
  ('10000000-0000-0000-0000-000000000004', 'ACTIVE', 'verify-c-owner');

-- A: creator has no membership.
INSERT INTO tenants (id, status, created_by_account_id) VALUES
  ('20000000-0000-0000-0000-000000000001', 'ACTIVE', '10000000-0000-0000-0000-000000000001');

-- B: creator is already the active owner.
INSERT INTO tenants (id, status, created_by_account_id) VALUES
  ('20000000-0000-0000-0000-000000000002', 'ACTIVE', '10000000-0000-0000-0000-000000000002');
INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status, accepted_at) VALUES
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'CLINIC_OWNER', 'ACTIVE', current_timestamp);

-- C: a different account is already the active owner.
INSERT INTO tenants (id, status, created_by_account_id) VALUES
  ('20000000-0000-0000-0000-000000000003', 'ACTIVE', '10000000-0000-0000-0000-000000000003');
INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status, accepted_at) VALUES
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004', 'CLINIC_OWNER', 'ACTIVE', current_timestamp);
COMMIT;
\endif

\if :{?assert_success}
\echo 'Asserting Cases A, B, C and membership migration invariants'
DO $$
DECLARE
  role_definition text;
BEGIN
  -- A: one creator owner was backfilled.
  IF (SELECT count(*) FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000001' AND account_id = '10000000-0000-0000-0000-000000000001' AND role_key = 'CLINIC_OWNER' AND status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'Case A failed: expected exactly one active creator owner';
  END IF;
  -- B: the pre-existing owner was preserved, with no duplicate.
  IF (SELECT count(*) FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000002' AND account_id = '10000000-0000-0000-0000-000000000002' AND role_key = 'CLINIC_OWNER' AND status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'Case B failed: expected exactly one unchanged active creator owner';
  END IF;
  -- C: the existing other owner remains sole owner; creator was not promoted.
  IF (SELECT count(*) FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000003' AND account_id = '10000000-0000-0000-0000-000000000004' AND role_key = 'CLINIC_OWNER' AND status = 'ACTIVE') <> 1
     OR EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000003' AND account_id = '10000000-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'Case C failed: creator was changed or existing owner was not preserved';
  END IF;
  -- Global invariant: every active tenant has an active owner.
  IF EXISTS (SELECT 1 FROM tenants t WHERE t.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.role_key = 'CLINIC_OWNER' AND m.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'active tenant without active clinic owner after migration';
  END IF;
  -- Existing partial unique invariant must still hold.
  IF EXISTS (SELECT 1 FROM tenant_memberships WHERE status IN ('ACTIVE', 'INVITED') GROUP BY tenant_id, account_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate active or invited tenant membership found';
  END IF;
  -- Expanded role vocabulary must be installed exactly as approved.
  SELECT pg_get_constraintdef(oid) INTO role_definition FROM pg_constraint WHERE conname = 'tenant_memberships_role_check';
  IF position('DOCTOR' IN role_definition) = 0
     OR position('PATIENT' IN role_definition) = 0 THEN
    RAISE EXCEPTION 'expanded membership role constraint is not present';
  END IF;
END $$;

SELECT 'PASS A/B/C and global owner invariants' AS result;
\endif

\if :{?cleanup_success}
\echo 'Cleaning A, B, and C fixtures after membership migration DOWN'
BEGIN;
DELETE FROM tenant_memberships WHERE tenant_id IN (
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003'
);
DELETE FROM tenants WHERE id IN (
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003'
);
DELETE FROM accounts WHERE id IN (
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000004'
);
COMMIT;
\endif

\if :{?seed_failure}
\echo 'Seeding Case D in foundation state'
BEGIN;
INSERT INTO accounts (id, status, display_name) VALUES
  ('10000000-0000-0000-0000-000000000005', 'ACTIVE', 'verify-d-creator');
INSERT INTO tenants (id, status, created_by_account_id) VALUES
  ('20000000-0000-0000-0000-000000000004', 'ACTIVE', '10000000-0000-0000-0000-000000000005');
-- CLINIC_STAFF is valid in the original foundation role constraint.
INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status, invited_at) VALUES
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000005', 'CLINIC_STAFF', 'INVITED', current_timestamp);
COMMIT;
\endif

\if :{?assert_failure_cleanup}
\echo 'Asserting Case D after expected membership migration UP failure, then cleaning fixtures'
DO $$
BEGIN
  -- The failed migration must not promote the creator or leave its schema changes applied.
  IF EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000004' AND account_id = '10000000-0000-0000-0000-000000000005' AND role_key = 'CLINIC_OWNER') THEN
    RAISE EXCEPTION 'Case D failed: creator was promoted to CLINIC_OWNER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE id = '30000000-0000-0000-0000-000000000004' AND role_key = 'CLINIC_STAFF' AND status = 'INVITED') THEN
    RAISE EXCEPTION 'Case D failed: original creator membership changed';
  END IF;
  IF to_regclass('public.tenant_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'Case D failed: failed migration left tenant_invitations behind';
  END IF;
END $$;
BEGIN;
DELETE FROM tenant_memberships WHERE tenant_id = '20000000-0000-0000-0000-000000000004';
DELETE FROM tenants WHERE id = '20000000-0000-0000-0000-000000000004';
DELETE FROM accounts WHERE id = '10000000-0000-0000-0000-000000000005';
COMMIT;
SELECT 'PASS D expected migration failure, no promotion, and cleanup' AS result;
\endif

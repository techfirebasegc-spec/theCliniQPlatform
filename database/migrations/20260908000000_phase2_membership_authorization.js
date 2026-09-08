const membershipRoles = "'CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF', 'DOCTOR', 'PATIENT'";
const invitationStatuses = "'INVITED', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED'";

exports.up = (pgm) => {
  pgm.dropConstraint('tenant_memberships', 'tenant_memberships_role_check');
  pgm.addConstraint('tenant_memberships', 'tenant_memberships_role_check', { check: `role_key IN (${membershipRoles})` });

  // This extension supplies UUIDs only for the migration's legacy-owner backfill.
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createTable('tenant_invitations', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    target_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    role_key: { type: 'text', notNull: true },
    secret_hash: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    accepted_at: { type: 'timestamptz' },
    accepted_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    rejected_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    revoked_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    created_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('tenant_invitations', 'tenant_invitations_role_check', { check: `role_key IN (${membershipRoles})` });
  pgm.addConstraint('tenant_invitations', 'tenant_invitations_status_check', { check: `status IN (${invitationStatuses})` });
  pgm.addConstraint('tenant_invitations', 'tenant_invitations_lifecycle_check', { check: "(status = 'ACCEPTED') = (accepted_at IS NOT NULL AND accepted_by_account_id IS NOT NULL) AND (status <> 'ACCEPTED' OR accepted_by_account_id = target_account_id)" });
  pgm.addConstraint('tenant_invitations', 'tenant_invitations_expiry_check', { check: 'expires_at > created_at' });
  pgm.addConstraint('tenant_invitations', 'tenant_invitations_secret_hash_unique', { unique: 'secret_hash' });
  pgm.createIndex('tenant_invitations', ['tenant_id', 'target_account_id'], { name: 'tenant_invitations_open_target_unique', unique: true, where: "status = 'INVITED'" });
  pgm.createIndex('tenant_invitations', ['target_account_id', 'status', 'expires_at']);
  pgm.createIndex('tenant_invitations', ['tenant_id', 'status', 'created_at']);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM tenants
        JOIN tenant_memberships creator_membership
          ON creator_membership.tenant_id = tenants.id
         AND creator_membership.account_id = tenants.created_by_account_id
         AND creator_membership.status IN ('INVITED', 'ACTIVE')
         AND creator_membership.role_key <> 'CLINIC_OWNER'
        WHERE tenants.status = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM tenant_memberships owners
            WHERE owners.tenant_id = tenants.id
              AND owners.role_key = 'CLINIC_OWNER'
              AND owners.status = 'ACTIVE'
          )
      ) THEN
        RAISE EXCEPTION 'active tenant creator has a non-owner active or invited membership without an active clinic owner';
      END IF;
    END $$;

    INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status, accepted_at, created_at, updated_at)
    SELECT gen_random_uuid(), tenants.id, tenants.created_by_account_id, 'CLINIC_OWNER', 'ACTIVE', current_timestamp, current_timestamp, current_timestamp
    FROM tenants
    WHERE tenants.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships owners
        WHERE owners.tenant_id = tenants.id AND owners.role_key = 'CLINIC_OWNER' AND owners.status = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships existing
        WHERE existing.tenant_id = tenants.id
          AND existing.account_id = tenants.created_by_account_id
      );
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM tenants
        WHERE status = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM tenant_memberships owners
            WHERE owners.tenant_id = tenants.id AND owners.role_key = 'CLINIC_OWNER' AND owners.status = 'ACTIVE'
          )
      ) THEN
        RAISE EXCEPTION 'active tenant without an active clinic owner membership';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tenant_invitations) THEN
        RAISE EXCEPTION 'cannot roll back membership authorization while invitation records exist';
      END IF;
      IF EXISTS (SELECT 1 FROM tenant_memberships WHERE role_key IN ('DOCTOR', 'PATIENT')) THEN
        RAISE EXCEPTION 'cannot roll back membership authorization while doctor or patient memberships exist';
      END IF;
    END $$;
  `);
  pgm.dropTable('tenant_invitations');
  pgm.dropConstraint('tenant_memberships', 'tenant_memberships_role_check');
  pgm.addConstraint('tenant_memberships', 'tenant_memberships_role_check', { check: "role_key IN ('CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF')" });
};

exports.up = (pgm) => {
  pgm.dropConstraint('authentication_identities', 'authentication_identities_provider_check');
  pgm.addConstraint('authentication_identities', 'authentication_identities_provider_check', { check: "provider IN ('firebase_google', 'firebase_phone', 'firebase_password')" });

  pgm.createTable('platform_admin_entitlements', {
    id: { type: 'uuid', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    granted_at: { type: 'timestamptz', notNull: true },
    granted_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    revoked_at: { type: 'timestamptz' },
    revoked_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('platform_admin_entitlements', 'platform_admin_entitlements_status_check', { check: "status IN ('ACTIVE', 'REVOKED')" });
  pgm.addConstraint('platform_admin_entitlements', 'platform_admin_entitlements_lifecycle_check', { check: "(status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by_account_id IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)" });
  pgm.createIndex('platform_admin_entitlements', ['account_id'], { name: 'platform_admin_entitlements_active_account_unique', unique: true, where: "status = 'ACTIVE'" });
  pgm.createIndex('platform_admin_entitlements', ['account_id', 'status']);
};

exports.down = (pgm) => {
  pgm.sql("DO $$ BEGIN IF EXISTS (SELECT 1 FROM authentication_identities WHERE provider = 'firebase_password') THEN RAISE EXCEPTION 'cannot roll back firebase_password provider while identities exist'; END IF; IF EXISTS (SELECT 1 FROM platform_admin_entitlements) THEN RAISE EXCEPTION 'cannot roll back platform admin entitlements while records exist'; END IF; END $$;");
  pgm.dropTable('platform_admin_entitlements');
  pgm.dropConstraint('authentication_identities', 'authentication_identities_provider_check');
  pgm.addConstraint('authentication_identities', 'authentication_identities_provider_check', { check: "provider IN ('firebase_google', 'firebase_phone')" });
};

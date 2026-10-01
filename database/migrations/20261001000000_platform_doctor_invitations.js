/* Platform-scoped doctor onboarding. Clinic relationships remain network_connections. */
exports.up = (pgm) => {
  pgm.createTable('doctor_invitations', {
    id: { type: 'uuid', primaryKey: true },
    target_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    invited_email_normalized: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    secret_hash: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'INVITED' },
    expires_at: { type: 'timestamptz', notNull: true },
    accepted_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    revoked_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('doctor_invitations', 'doctor_invitations_status_check', { check: "status IN ('INVITED', 'ACCEPTED', 'REVOKED', 'EXPIRED')" });
  pgm.createIndex('doctor_invitations', ['invited_email_normalized', 'status', 'expires_at']);
  pgm.createIndex('doctor_invitations', ['target_account_id', 'status']);
  pgm.createIndex('doctor_invitations', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('doctor_invitations');
};

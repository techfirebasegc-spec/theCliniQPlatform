/* Email-bound owner onboarding extends the existing account-targeted invitation lifecycle. */
exports.up = (pgm) => {
  pgm.addColumn('tenant_invitations', { invited_email_normalized: { type: 'text' } });
  pgm.createIndex('tenant_invitations', ['tenant_id', 'invited_email_normalized'], {
    name: 'tenant_invitations_open_email_unique', unique: true,
    where: "status = 'INVITED' AND invited_email_normalized IS NOT NULL",
  });
  pgm.createIndex('tenant_invitations', ['invited_email_normalized', 'status', 'expires_at'], {
    name: 'tenant_invitations_email_status_expiry',
    where: 'invited_email_normalized IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.sql("DO $$ BEGIN IF EXISTS (SELECT 1 FROM tenant_invitations WHERE invited_email_normalized IS NOT NULL) THEN RAISE EXCEPTION 'cannot roll back tenant owner onboarding while email-bound invitations exist'; END IF; END $$;");
  pgm.dropIndex('tenant_invitations', ['invited_email_normalized', 'status', 'expires_at'], { name: 'tenant_invitations_email_status_expiry' });
  pgm.dropIndex('tenant_invitations', ['tenant_id', 'invited_email_normalized'], { name: 'tenant_invitations_open_email_unique' });
  pgm.dropColumn('tenant_invitations', 'invited_email_normalized');
};

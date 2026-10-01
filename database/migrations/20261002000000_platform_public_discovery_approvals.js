/* Platform approval is an additional public-discovery gate; service_exposures remain the bookable projection. */
exports.up = (pgm) => {
  pgm.createTable('platform_public_discovery_approvals', {
    id: { type: 'uuid', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' },
    doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    published_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('platform_public_discovery_approvals', 'platform_public_discovery_approvals_subject_check', { check: "(subject_kind='CLINIC' AND clinic_id IS NOT NULL AND doctor_profile_id IS NULL) OR (subject_kind='DOCTOR' AND clinic_id IS NULL AND doctor_profile_id IS NOT NULL)" });
  pgm.addConstraint('platform_public_discovery_approvals', 'platform_public_discovery_approvals_status_check', { check: "status IN ('PUBLISHED','REVOKED')" });
  pgm.createIndex('platform_public_discovery_approvals', 'clinic_id', { unique: true, where: "subject_kind='CLINIC'" });
  pgm.createIndex('platform_public_discovery_approvals', 'doctor_profile_id', { unique: true, where: "subject_kind='DOCTOR'" });
  pgm.createIndex('platform_public_discovery_approvals', ['subject_kind', 'status']);
};

exports.down = (pgm) => pgm.dropTable('platform_public_discovery_approvals');

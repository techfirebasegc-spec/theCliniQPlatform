/* eslint-disable max-lines */

const accountStatuses = "'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED_REQUESTED', 'DELETED'";
const authenticationIdentityStatuses = "'LINKED', 'UNLINKED', 'COMPROMISED', 'DISABLED'";
const sessionStatuses = "'ACTIVE', 'EXPIRED', 'REVOKED', 'REPLACED', 'SUSPICIOUS'";
const patientProfileStatuses = "'ACTIVE', 'INACTIVE', 'ARCHIVED'";
const doctorProfileStatuses = "'DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'";
const verificationStatuses = "'NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'";
const tenantStatuses = "'PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ARCHIVED'";
const clinicStatuses = "'DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED'";
const membershipRoles = "'CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF'";
const membershipStatuses = "'INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED', 'EXPIRED'";
const connectionStatuses = "'PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'BLOCKED'";
const connectionEvents = "'CONNECTION_CREATED', 'CONNECTION_ACCEPTED', 'CONNECTION_REJECTED', 'CONNECTION_REVOKED', 'CONNECTION_BLOCKED', 'CAPABILITY_GRANTED', 'CAPABILITY_REVOKED'";

exports.up = (pgm) => {
  pgm.createTable('accounts', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('accounts', 'accounts_status_check', { check: `status IN (${accountStatuses})` });
  pgm.createIndex('accounts', 'status');
  pgm.createIndex('accounts', 'created_at');

  pgm.createTable('authentication_identities', {
    id: { type: 'uuid', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    provider: { type: 'text', notNull: true },
    provider_subject: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    verified_at: { type: 'timestamptz', notNull: true },
    linked_at: { type: 'timestamptz', notNull: true },
    unlinked_at: { type: 'timestamptz' },
    last_authenticated_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('authentication_identities', 'authentication_identities_provider_check', { check: "provider IN ('firebase_google', 'firebase_phone')" });
  pgm.addConstraint('authentication_identities', 'authentication_identities_status_check', { check: `status IN (${authenticationIdentityStatuses})` });
  pgm.addConstraint('authentication_identities', 'authentication_identities_provider_subject_unique', { unique: ['provider', 'provider_subject'] });
  pgm.createIndex('authentication_identities', ['account_id', 'status']);

  pgm.createTable('sessions', {
    id: { type: 'uuid', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    secret_hash: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    idle_expires_at: { type: 'timestamptz', notNull: true },
    absolute_expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    revoked_reason: { type: 'text' },
    user_agent_summary: { type: 'text' },
    ip_hash: { type: 'text' },
    created_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('sessions', 'sessions_status_check', { check: `status IN (${sessionStatuses})` });
  pgm.addConstraint('sessions', 'sessions_absolute_expiry_check', { check: 'absolute_expires_at > created_at' });
  pgm.addConstraint('sessions', 'sessions_idle_expiry_check', { check: 'idle_expires_at <= absolute_expires_at' });
  pgm.createIndex('sessions', ['account_id', 'status']);
  pgm.createIndex('sessions', ['status', 'absolute_expires_at']);
  pgm.createIndex('sessions', ['status', 'idle_expires_at']);

  pgm.createTable('patient_profiles', {
    id: { type: 'uuid', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, unique: true, references: 'accounts', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('patient_profiles', 'patient_profiles_status_check', { check: `status IN (${patientProfileStatuses})` });
  pgm.createIndex('patient_profiles', ['account_id', 'status']);

  pgm.createTable('doctor_profiles', {
    id: { type: 'uuid', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, unique: true, references: 'accounts', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    professional_verification_status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('doctor_profiles', 'doctor_profiles_status_check', { check: `status IN (${doctorProfileStatuses})` });
  pgm.addConstraint('doctor_profiles', 'doctor_profiles_verification_status_check', { check: `professional_verification_status IN (${verificationStatuses})` });
  pgm.createIndex('doctor_profiles', ['account_id', 'status']);
  pgm.createIndex('doctor_profiles', 'professional_verification_status');

  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    deactivated_at: { type: 'timestamptz' },
    deactivated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('tenants', 'tenants_status_check', { check: `status IN (${tenantStatuses})` });
  pgm.createIndex('tenants', 'status');
  pgm.createIndex('tenants', 'created_by_account_id');

  pgm.createTable('clinics', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, unique: true, references: 'tenants', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    legal_name: { type: 'text', notNull: true },
    display_name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    created_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    updated_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    closed_at: { type: 'timestamptz' },
    closed_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('clinics', 'clinics_status_check', { check: `status IN (${clinicStatuses})` });
  pgm.createIndex('clinics', 'status');
  pgm.createIndex('clinics', 'display_name');

  pgm.createTable('tenant_memberships', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'RESTRICT' },
    account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    role_key: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    invited_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    invited_at: { type: 'timestamptz' },
    accepted_at: { type: 'timestamptz' },
    removed_at: { type: 'timestamptz' },
    removed_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    removal_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('tenant_memberships', 'tenant_memberships_role_check', { check: `role_key IN (${membershipRoles})` });
  pgm.addConstraint('tenant_memberships', 'tenant_memberships_status_check', { check: `status IN (${membershipStatuses})` });
  pgm.createIndex('tenant_memberships', ['tenant_id', 'account_id'], { name: 'tenant_memberships_active_or_invited_unique', unique: true, where: "status IN ('INVITED', 'ACTIVE')" });
  pgm.createIndex('tenant_memberships', ['tenant_id', 'status']);
  pgm.createIndex('tenant_memberships', ['account_id', 'status']);
  pgm.createIndex('tenant_memberships', ['tenant_id', 'role_key', 'status']);

  pgm.createTable('network_connections', {
    id: { type: 'uuid', primaryKey: true },
    connection_kind: { type: 'text', notNull: true },
    clinic_left_id: { type: 'uuid', notNull: true, references: 'clinics', onDelete: 'RESTRICT' },
    clinic_right_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' },
    doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
    status: { type: 'text', notNull: true },
    initiated_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    recipient_party_kind: { type: 'text', notNull: true },
    accepted_at: { type: 'timestamptz' },
    rejected_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    blocked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('network_connections', 'network_connections_kind_check', { check: "connection_kind IN ('CLINIC_CLINIC', 'CLINIC_DOCTOR')" });
  pgm.addConstraint('network_connections', 'network_connections_status_check', { check: `status IN (${connectionStatuses})` });
  pgm.addConstraint('network_connections', 'network_connections_party_shape_check', { check: "(connection_kind = 'CLINIC_CLINIC' AND clinic_right_id IS NOT NULL AND doctor_profile_id IS NULL AND clinic_left_id < clinic_right_id AND recipient_party_kind = 'CLINIC') OR (connection_kind = 'CLINIC_DOCTOR' AND clinic_right_id IS NULL AND doctor_profile_id IS NOT NULL AND recipient_party_kind IN ('CLINIC', 'DOCTOR'))" });
  pgm.createIndex('network_connections', ['clinic_left_id', 'clinic_right_id'], { name: 'network_connections_active_clinic_clinic_unique', unique: true, where: "connection_kind = 'CLINIC_CLINIC' AND status IN ('PENDING', 'ACCEPTED')" });
  pgm.createIndex('network_connections', ['clinic_left_id', 'doctor_profile_id'], { name: 'network_connections_active_clinic_doctor_unique', unique: true, where: "connection_kind = 'CLINIC_DOCTOR' AND status IN ('PENDING', 'ACCEPTED')" });
  pgm.createIndex('network_connections', ['clinic_left_id', 'status']);
  pgm.createIndex('network_connections', ['clinic_right_id', 'status']);
  pgm.createIndex('network_connections', ['doctor_profile_id', 'status']);
  pgm.createIndex('network_connections', ['status', 'created_at']);

  pgm.createTable('network_connection_capabilities', {
    id: { type: 'uuid', primaryKey: true },
    network_connection_id: { type: 'uuid', notNull: true, references: 'network_connections', onDelete: 'RESTRICT' },
    capability_key: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    granted_at: { type: 'timestamptz', notNull: true },
    granted_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' },
    revoked_at: { type: 'timestamptz' },
    revoked_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('network_connection_capabilities', 'network_connection_capabilities_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT')" });
  pgm.addConstraint('network_connection_capabilities', 'network_connection_capabilities_status_check', { check: "status IN ('ACTIVE', 'REVOKED')" });
  pgm.createIndex('network_connection_capabilities', ['network_connection_id', 'capability_key'], { name: 'network_connection_capabilities_active_unique', unique: true, where: "status = 'ACTIVE'" });
  pgm.createIndex('network_connection_capabilities', ['network_connection_id', 'status']);

  pgm.createTable('network_connection_events', {
    id: { type: 'uuid', primaryKey: true },
    network_connection_id: { type: 'uuid', notNull: true, references: 'network_connections', onDelete: 'RESTRICT' },
    event_type: { type: 'text', notNull: true },
    actor_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });
  pgm.addConstraint('network_connection_events', 'network_connection_events_type_check', { check: `event_type IN (${connectionEvents})` });
  pgm.addConstraint('network_connection_events', 'network_connection_events_metadata_check', { check: "jsonb_typeof(metadata) = 'object'" });
  pgm.createIndex('network_connection_events', ['network_connection_id', 'occurred_at']);

  pgm.createTable('audit_events', {
    id: { type: 'uuid', primaryKey: true },
    category: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    actor_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'RESTRICT' },
    target_type: { type: 'text', notNull: true },
    target_id: { type: 'uuid' },
    outcome: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    ip_hash: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });
  pgm.addConstraint('audit_events', 'audit_events_category_check', { check: "category IN ('SECURITY', 'AUTHORIZATION', 'BUSINESS')" });
  pgm.addConstraint('audit_events', 'audit_events_outcome_check', { check: "outcome IN ('SUCCESS', 'DENIED', 'FAILURE')" });
  pgm.addConstraint('audit_events', 'audit_events_event_type_check', { check: "char_length(event_type) > 0" });
  pgm.addConstraint('audit_events', 'audit_events_target_type_check', { check: "char_length(target_type) > 0" });
  pgm.addConstraint('audit_events', 'audit_events_metadata_check', { check: "jsonb_typeof(metadata) = 'object'" });
  pgm.createIndex('audit_events', ['actor_account_id', 'occurred_at']);
  pgm.createIndex('audit_events', ['tenant_id', 'occurred_at']);
  pgm.createIndex('audit_events', ['target_type', 'target_id', 'occurred_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('audit_events');
  pgm.dropTable('network_connection_events');
  pgm.dropTable('network_connection_capabilities');
  pgm.dropTable('network_connections');
  pgm.dropTable('tenant_memberships');
  pgm.dropTable('clinics');
  pgm.dropTable('tenants');
  pgm.dropTable('doctor_profiles');
  pgm.dropTable('patient_profiles');
  pgm.dropTable('sessions');
  pgm.dropTable('authentication_identities');
  pgm.dropTable('accounts');
};

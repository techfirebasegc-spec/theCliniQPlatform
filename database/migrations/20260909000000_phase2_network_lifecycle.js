/* Phase 2 Steps 9-12. Historical migrations remain immutable. */
exports.up = (pgm) => {
  pgm.sql("UPDATE network_connections SET status = 'REQUESTED' WHERE status = 'PENDING'");
  pgm.dropConstraint('network_connections', 'network_connections_status_check');
  pgm.addConstraint('network_connections', 'network_connections_status_check', { check: "status IN ('REQUESTED', 'ACCEPTED', 'REJECTED', 'REVOKED', 'BLOCKED')" });
  // The foundation migration names these indexes explicitly. Use their exact
  // PostgreSQL names rather than node-pg-migrate's derived column-name form.
  pgm.sql('DROP INDEX IF EXISTS network_connections_active_clinic_clinic_unique');
  pgm.sql('DROP INDEX IF EXISTS network_connections_active_clinic_doctor_unique');
  pgm.createIndex('network_connections', ['clinic_left_id', 'clinic_right_id'], { name: 'network_connections_active_clinic_clinic_unique', unique: true, where: "connection_kind = 'CLINIC_CLINIC' AND status IN ('REQUESTED', 'ACCEPTED')" });
  pgm.createIndex('network_connections', ['clinic_left_id', 'doctor_profile_id'], { name: 'network_connections_active_clinic_doctor_unique', unique: true, where: "connection_kind = 'CLINIC_DOCTOR' AND status IN ('REQUESTED', 'ACCEPTED')" });
  pgm.addColumns('network_connections', { initiator_party_kind: { type: 'text', notNull: true }, initiator_clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' }, initiator_doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' } });
  pgm.addConstraint('network_connections', 'network_connections_initiator_party_check', { check: "(initiator_party_kind = 'CLINIC' AND initiator_clinic_id IS NOT NULL AND initiator_doctor_profile_id IS NULL) OR (initiator_party_kind = 'DOCTOR' AND initiator_clinic_id IS NULL AND initiator_doctor_profile_id IS NOT NULL)" });
  pgm.createTable('network_capability_proposals', {
    id: { type: 'uuid', primaryKey: true }, network_connection_id: { type: 'uuid', notNull: true, references: 'network_connections', onDelete: 'RESTRICT' }, capability_key: { type: 'text', notNull: true },
    proposer_party_kind: { type: 'text', notNull: true }, proposer_clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' }, proposer_doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
    accepter_party_kind: { type: 'text', notNull: true }, accepter_clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' }, accepter_doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
    proposed_by_account_id: { type: 'uuid', notNull: true, references: 'accounts', onDelete: 'RESTRICT' }, accepted_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' }, revoked_by_account_id: { type: 'uuid', references: 'accounts', onDelete: 'RESTRICT' }, status: { type: 'text', notNull: true }, accepted_at: { type: 'timestamptz' }, revoked_at: { type: 'timestamptz' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT')" });
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_status_check', { check: "status IN ('PENDING', 'ACCEPTED', 'REVOKED')" });
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_party_shape_check', { check: "((proposer_party_kind = 'CLINIC' AND proposer_clinic_id IS NOT NULL AND proposer_doctor_profile_id IS NULL) OR (proposer_party_kind = 'DOCTOR' AND proposer_clinic_id IS NULL AND proposer_doctor_profile_id IS NOT NULL)) AND ((accepter_party_kind = 'CLINIC' AND accepter_clinic_id IS NOT NULL AND accepter_doctor_profile_id IS NULL) OR (accepter_party_kind = 'DOCTOR' AND accepter_clinic_id IS NULL AND accepter_doctor_profile_id IS NOT NULL)) AND NOT (proposer_party_kind = 'DOCTOR' AND accepter_party_kind = 'DOCTOR') AND (proposer_party_kind <> accepter_party_kind OR proposer_clinic_id <> accepter_clinic_id)" });
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_state_check', { check: "(status = 'PENDING' AND accepted_at IS NULL AND revoked_at IS NULL) OR (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)" });
  pgm.createIndex('network_capability_proposals', ['network_connection_id', 'capability_key'], { name: 'network_capability_proposals_pending_unique', unique: true, where: "status = 'PENDING'" });
  pgm.createIndex('network_capability_proposals', ['network_connection_id', 'status']);
  pgm.sql(`
    CREATE FUNCTION enforce_network_capability_bilateral_consent() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'ACTIVE' AND NOT EXISTS (
        SELECT 1 FROM network_capability_proposals proposal
        WHERE proposal.network_connection_id = NEW.network_connection_id
          AND proposal.capability_key = NEW.capability_key
          AND proposal.status = 'ACCEPTED'
          AND proposal.accepted_at IS NOT NULL
          AND proposal.accepted_by_account_id IS NOT NULL
          AND ((proposal.accepter_party_kind = 'CLINIC' AND EXISTS (
            SELECT 1 FROM clinics clinic JOIN tenants tenant ON tenant.id = clinic.tenant_id JOIN tenant_memberships membership ON membership.tenant_id = tenant.id
            WHERE clinic.id = proposal.accepter_clinic_id AND membership.account_id = proposal.accepted_by_account_id AND membership.status = 'ACTIVE' AND membership.role_key IN ('CLINIC_OWNER', 'CLINIC_ADMIN') AND tenant.status = 'ACTIVE' AND clinic.status = 'ACTIVE'
          )) OR (proposal.accepter_party_kind = 'DOCTOR' AND EXISTS (
            SELECT 1 FROM doctor_profiles doctor WHERE doctor.id = proposal.accepter_doctor_profile_id AND doctor.account_id = proposal.accepted_by_account_id AND doctor.status = 'ACTIVE' AND doctor.professional_verification_status = 'VERIFIED'
          )))
      ) THEN RAISE EXCEPTION 'active network capability requires accepted bilateral consent'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER network_capability_bilateral_consent_trigger BEFORE INSERT OR UPDATE OF status, network_connection_id, capability_key ON network_connection_capabilities FOR EACH ROW EXECUTE FUNCTION enforce_network_capability_bilateral_consent();
  `);
};
exports.down = (pgm) => { pgm.sql('DROP TRIGGER network_capability_bilateral_consent_trigger ON network_connection_capabilities; DROP FUNCTION enforce_network_capability_bilateral_consent();'); pgm.dropTable('network_capability_proposals'); pgm.dropConstraint('network_connections', 'network_connections_initiator_party_check'); pgm.dropColumns('network_connections', ['initiator_party_kind', 'initiator_clinic_id', 'initiator_doctor_profile_id']); pgm.sql('DROP INDEX IF EXISTS network_connections_active_clinic_clinic_unique'); pgm.sql('DROP INDEX IF EXISTS network_connections_active_clinic_doctor_unique'); pgm.sql("UPDATE network_connections SET status = 'PENDING' WHERE status = 'REQUESTED'"); pgm.dropConstraint('network_connections', 'network_connections_status_check'); pgm.addConstraint('network_connections', 'network_connections_status_check', { check: "status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'BLOCKED')" }); pgm.createIndex('network_connections', ['clinic_left_id', 'clinic_right_id'], { name: 'network_connections_active_clinic_clinic_unique', unique: true, where: "connection_kind = 'CLINIC_CLINIC' AND status IN ('PENDING', 'ACCEPTED')" }); pgm.createIndex('network_connections', ['clinic_left_id', 'doctor_profile_id'], { name: 'network_connections_active_clinic_doctor_unique', unique: true, where: "connection_kind = 'CLINIC_DOCTOR' AND status IN ('PENDING', 'ACCEPTED')" }); };

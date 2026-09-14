/* Phase 5.8 Step 1. Directional capability evidence extends, but never replaces, Phase 2 network consent. */
exports.up = (pgm) => {
  pgm.dropConstraint('network_connection_capabilities', 'network_connection_capabilities_key_check');
  pgm.addConstraint('network_connection_capabilities', 'network_connection_capabilities_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT', 'BOOK', 'REFER')" });
  pgm.dropConstraint('network_capability_proposals', 'network_capability_proposals_key_check');
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT', 'BOOK', 'REFER')" });
  pgm.addColumns('network_connection_capabilities', {
    accepted_proposal_id: { type: 'uuid', references: 'network_capability_proposals', onDelete: 'RESTRICT' },
    grantor_party_kind: { type: 'text' }, grantor_clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' }, grantor_doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
    grantee_party_kind: { type: 'text' }, grantee_clinic_id: { type: 'uuid', references: 'clinics', onDelete: 'RESTRICT' }, grantee_doctor_profile_id: { type: 'uuid', references: 'doctor_profiles', onDelete: 'RESTRICT' },
  });
  pgm.addConstraint('network_connection_capabilities', 'network_connection_capabilities_directional_party_shape_check', { check: "(capability_key IN ('DISCOVER', 'CONTACT') AND grantor_party_kind IS NULL AND grantor_clinic_id IS NULL AND grantor_doctor_profile_id IS NULL AND grantee_party_kind IS NULL AND grantee_clinic_id IS NULL AND grantee_doctor_profile_id IS NULL) OR (capability_key IN ('BOOK', 'REFER') AND ((grantor_party_kind = 'CLINIC' AND grantor_clinic_id IS NOT NULL AND grantor_doctor_profile_id IS NULL) OR (grantor_party_kind = 'DOCTOR' AND grantor_clinic_id IS NULL AND grantor_doctor_profile_id IS NOT NULL)) AND ((grantee_party_kind = 'CLINIC' AND grantee_clinic_id IS NOT NULL AND grantee_doctor_profile_id IS NULL) OR (grantee_party_kind = 'DOCTOR' AND grantee_clinic_id IS NULL AND grantee_doctor_profile_id IS NOT NULL)))" });
  pgm.sql(`
    DROP INDEX IF EXISTS network_connections_capabilities_active_unique;
    CREATE UNIQUE INDEX network_connection_capabilities_symmetric_active_unique
      ON network_connection_capabilities (network_connection_id, capability_key)
      WHERE status = 'ACTIVE' AND capability_key IN ('DISCOVER', 'CONTACT');
    CREATE UNIQUE INDEX network_connection_capabilities_book_active_unique
      ON network_connection_capabilities (network_connection_id, capability_key, grantor_doctor_profile_id)
      WHERE status = 'ACTIVE' AND capability_key = 'BOOK';
    CREATE UNIQUE INDEX network_connection_capabilities_refer_active_unique
      ON network_connection_capabilities (network_connection_id, capability_key, grantor_clinic_id)
      WHERE status = 'ACTIVE' AND capability_key = 'REFER';

    CREATE FUNCTION enforce_network_capability_proposal_context() RETURNS trigger AS $$
    DECLARE connection_row network_connections%ROWTYPE;
    BEGIN
      SELECT * INTO connection_row FROM network_connections WHERE id = NEW.network_connection_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'network capability proposal requires a network connection'; END IF;
      IF connection_row.status <> 'ACCEPTED' THEN RAISE EXCEPTION 'network capability proposal requires an accepted connection'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.status IN ('ACCEPTED', 'REVOKED') AND (OLD.network_connection_id IS DISTINCT FROM NEW.network_connection_id OR OLD.capability_key IS DISTINCT FROM NEW.capability_key OR OLD.proposer_party_kind IS DISTINCT FROM NEW.proposer_party_kind OR OLD.proposer_clinic_id IS DISTINCT FROM NEW.proposer_clinic_id OR OLD.proposer_doctor_profile_id IS DISTINCT FROM NEW.proposer_doctor_profile_id OR OLD.accepter_party_kind IS DISTINCT FROM NEW.accepter_party_kind OR OLD.accepter_clinic_id IS DISTINCT FROM NEW.accepter_clinic_id OR OLD.accepter_doctor_profile_id IS DISTINCT FROM NEW.accepter_doctor_profile_id) THEN RAISE EXCEPTION 'accepted network capability proposal context is immutable'; END IF;
      IF NOT (
        (NEW.proposer_party_kind = 'CLINIC' AND NEW.proposer_clinic_id IN (connection_row.clinic_left_id, connection_row.clinic_right_id)) OR
        (NEW.proposer_party_kind = 'DOCTOR' AND NEW.proposer_doctor_profile_id = connection_row.doctor_profile_id)
      ) OR NOT (
        (NEW.accepter_party_kind = 'CLINIC' AND NEW.accepter_clinic_id IN (connection_row.clinic_left_id, connection_row.clinic_right_id)) OR
        (NEW.accepter_party_kind = 'DOCTOR' AND NEW.accepter_doctor_profile_id = connection_row.doctor_profile_id)
      ) THEN RAISE EXCEPTION 'network capability proposal parties must match connection parties'; END IF;
      IF NEW.capability_key = 'BOOK' AND NOT (NEW.proposer_party_kind = 'DOCTOR' AND NEW.accepter_party_kind = 'CLINIC' AND connection_row.connection_kind = 'CLINIC_DOCTOR') THEN RAISE EXCEPTION 'BOOK capability must be granted by doctor to clinic'; END IF;
      IF NEW.capability_key = 'REFER' AND NOT (NEW.proposer_party_kind = 'CLINIC' AND NEW.accepter_party_kind = 'CLINIC' AND connection_row.connection_kind = 'CLINIC_CLINIC') THEN RAISE EXCEPTION 'REFER capability must be granted by clinic to clinic'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.status = 'ACCEPTED' AND NEW.status = 'REVOKED' AND EXISTS (SELECT 1 FROM network_connection_capabilities capability WHERE capability.accepted_proposal_id = OLD.id AND capability.status = 'ACTIVE') THEN RAISE EXCEPTION 'active network capability requires its accepted proposal'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER network_capability_proposal_context_trigger
      BEFORE INSERT OR UPDATE OF network_connection_id, capability_key, proposer_party_kind, proposer_clinic_id, proposer_doctor_profile_id, accepter_party_kind, accepter_clinic_id, accepter_doctor_profile_id, status
      ON network_capability_proposals FOR EACH ROW EXECUTE FUNCTION enforce_network_capability_proposal_context();

    DROP TRIGGER network_capability_bilateral_consent_trigger ON network_connection_capabilities;
    DROP FUNCTION enforce_network_capability_bilateral_consent();
    CREATE FUNCTION enforce_network_capability_bilateral_consent() RETURNS trigger AS $$
    DECLARE proposal network_capability_proposals%ROWTYPE; connection_row network_connections%ROWTYPE;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.status = 'REVOKED' AND NEW.status = 'ACTIVE' THEN RAISE EXCEPTION 'revoked network capability cannot be reactivated'; END IF;
      IF TG_OP = 'UPDATE' AND (OLD.accepted_proposal_id IS DISTINCT FROM NEW.accepted_proposal_id OR OLD.grantor_party_kind IS DISTINCT FROM NEW.grantor_party_kind OR OLD.grantor_clinic_id IS DISTINCT FROM NEW.grantor_clinic_id OR OLD.grantor_doctor_profile_id IS DISTINCT FROM NEW.grantor_doctor_profile_id OR OLD.grantee_party_kind IS DISTINCT FROM NEW.grantee_party_kind OR OLD.grantee_clinic_id IS DISTINCT FROM NEW.grantee_clinic_id OR OLD.grantee_doctor_profile_id IS DISTINCT FROM NEW.grantee_doctor_profile_id) THEN RAISE EXCEPTION 'network capability direction evidence is immutable'; END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.accepted_proposal_id IS NULL THEN RAISE EXCEPTION 'network capability requires accepted proposal evidence'; END IF;
        SELECT * INTO proposal FROM network_capability_proposals WHERE id = NEW.accepted_proposal_id;
        IF NOT FOUND OR proposal.network_connection_id <> NEW.network_connection_id OR proposal.capability_key <> NEW.capability_key OR proposal.status <> 'ACCEPTED' THEN RAISE EXCEPTION 'network capability requires exact accepted proposal evidence'; END IF;
        IF NEW.capability_key IN ('BOOK', 'REFER') AND (NEW.grantor_party_kind IS DISTINCT FROM proposal.proposer_party_kind OR NEW.grantor_clinic_id IS DISTINCT FROM proposal.proposer_clinic_id OR NEW.grantor_doctor_profile_id IS DISTINCT FROM proposal.proposer_doctor_profile_id OR NEW.grantee_party_kind IS DISTINCT FROM proposal.accepter_party_kind OR NEW.grantee_clinic_id IS DISTINCT FROM proposal.accepter_clinic_id OR NEW.grantee_doctor_profile_id IS DISTINCT FROM proposal.accepter_doctor_profile_id) THEN RAISE EXCEPTION 'network capability direction must match accepted proposal'; END IF;
      END IF;
      IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
      IF NEW.accepted_proposal_id IS NULL THEN RAISE EXCEPTION 'active network capability requires accepted proposal evidence'; END IF;
      SELECT * INTO proposal FROM network_capability_proposals WHERE id = NEW.accepted_proposal_id;
      SELECT * INTO connection_row FROM network_connections WHERE id = NEW.network_connection_id;
      IF NOT FOUND OR connection_row.status <> 'ACCEPTED' OR proposal.network_connection_id <> NEW.network_connection_id OR proposal.capability_key <> NEW.capability_key OR proposal.status <> 'ACCEPTED' OR proposal.accepted_at IS NULL OR proposal.accepted_by_account_id IS NULL THEN RAISE EXCEPTION 'active network capability requires exact accepted bilateral proposal'; END IF;
      IF NOT ((proposal.accepter_party_kind = 'CLINIC' AND EXISTS (SELECT 1 FROM clinics clinic JOIN tenants tenant ON tenant.id = clinic.tenant_id JOIN tenant_memberships membership ON membership.tenant_id = tenant.id WHERE clinic.id = proposal.accepter_clinic_id AND membership.account_id = proposal.accepted_by_account_id AND membership.status = 'ACTIVE' AND membership.role_key IN ('CLINIC_OWNER', 'CLINIC_ADMIN') AND tenant.status = 'ACTIVE' AND clinic.status = 'ACTIVE')) OR (proposal.accepter_party_kind = 'DOCTOR' AND EXISTS (SELECT 1 FROM doctor_profiles doctor WHERE doctor.id = proposal.accepter_doctor_profile_id AND doctor.account_id = proposal.accepted_by_account_id AND doctor.status = 'ACTIVE' AND doctor.professional_verification_status = 'VERIFIED'))) THEN RAISE EXCEPTION 'active network capability requires eligible accepting party'; END IF;
      IF NEW.capability_key IN ('DISCOVER', 'CONTACT') THEN RETURN NEW; END IF;
      IF NEW.grantor_party_kind IS DISTINCT FROM proposal.proposer_party_kind OR NEW.grantor_clinic_id IS DISTINCT FROM proposal.proposer_clinic_id OR NEW.grantor_doctor_profile_id IS DISTINCT FROM proposal.proposer_doctor_profile_id OR NEW.grantee_party_kind IS DISTINCT FROM proposal.accepter_party_kind OR NEW.grantee_clinic_id IS DISTINCT FROM proposal.accepter_clinic_id OR NEW.grantee_doctor_profile_id IS DISTINCT FROM proposal.accepter_doctor_profile_id THEN RAISE EXCEPTION 'network capability direction must match accepted proposal'; END IF;
      IF NEW.capability_key = 'BOOK' AND NOT (NEW.grantor_party_kind = 'DOCTOR' AND NEW.grantee_party_kind = 'CLINIC' AND connection_row.connection_kind = 'CLINIC_DOCTOR') THEN RAISE EXCEPTION 'BOOK capability must be doctor to clinic'; END IF;
      IF NEW.capability_key = 'REFER' AND NOT (NEW.grantor_party_kind = 'CLINIC' AND NEW.grantee_party_kind = 'CLINIC' AND connection_row.connection_kind = 'CLINIC_CLINIC') THEN RAISE EXCEPTION 'REFER capability must be clinic to clinic'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER network_capability_bilateral_consent_trigger
      BEFORE INSERT OR UPDATE OF status, network_connection_id, capability_key, accepted_proposal_id, grantor_party_kind, grantor_clinic_id, grantor_doctor_profile_id, grantee_party_kind, grantee_clinic_id, grantee_doctor_profile_id
      ON network_connection_capabilities FOR EACH ROW EXECUTE FUNCTION enforce_network_capability_bilateral_consent();
  `);
};
exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM network_connection_capabilities WHERE capability_key IN ('BOOK', 'REFER') OR accepted_proposal_id IS NOT NULL) OR EXISTS (SELECT 1 FROM network_capability_proposals WHERE capability_key IN ('BOOK', 'REFER')) THEN
        RAISE EXCEPTION 'cannot roll back directional network capabilities while capability evidence exists';
      END IF;
    END $$;
    DROP TRIGGER network_capability_bilateral_consent_trigger ON network_connection_capabilities;
    DROP FUNCTION enforce_network_capability_bilateral_consent();
    DROP TRIGGER network_capability_proposal_context_trigger ON network_capability_proposals;
    DROP FUNCTION enforce_network_capability_proposal_context();
    CREATE FUNCTION enforce_network_capability_bilateral_consent() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM network_capability_proposals proposal WHERE proposal.network_connection_id = NEW.network_connection_id AND proposal.capability_key = NEW.capability_key AND proposal.status = 'ACCEPTED' AND proposal.accepted_at IS NOT NULL AND proposal.accepted_by_account_id IS NOT NULL) THEN RAISE EXCEPTION 'active network capability requires accepted bilateral consent'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER network_capability_bilateral_consent_trigger BEFORE INSERT OR UPDATE OF status, network_connection_id, capability_key ON network_connection_capabilities FOR EACH ROW EXECUTE FUNCTION enforce_network_capability_bilateral_consent();
    DROP INDEX network_connection_capabilities_symmetric_active_unique;
    DROP INDEX network_connection_capabilities_book_active_unique;
    DROP INDEX network_connection_capabilities_refer_active_unique;
    CREATE UNIQUE INDEX network_connection_capabilities_active_unique ON network_connection_capabilities (network_connection_id, capability_key) WHERE status = 'ACTIVE';
  `);
  pgm.dropConstraint('network_connection_capabilities', 'network_connection_capabilities_directional_party_shape_check');
  pgm.dropColumns('network_connection_capabilities', ['accepted_proposal_id', 'grantor_party_kind', 'grantor_clinic_id', 'grantor_doctor_profile_id', 'grantee_party_kind', 'grantee_clinic_id', 'grantee_doctor_profile_id']);
  pgm.dropConstraint('network_connection_capabilities', 'network_connection_capabilities_key_check');
  pgm.addConstraint('network_connection_capabilities', 'network_connection_capabilities_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT')" });
  pgm.dropConstraint('network_capability_proposals', 'network_capability_proposals_key_check');
  pgm.addConstraint('network_capability_proposals', 'network_capability_proposals_key_check', { check: "capability_key IN ('DISCOVER', 'CONTACT')" });
};

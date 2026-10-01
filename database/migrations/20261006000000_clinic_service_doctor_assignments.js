/* Clinic-owned service delivery eligibility; it does not change service ownership or booking. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE clinic_service_doctor_assignments (
      id uuid PRIMARY KEY,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      doctor_profile_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      network_connection_id uuid NOT NULL REFERENCES network_connections(id) ON DELETE RESTRICT,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      revoked_at timestamptz,
      revoked_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      CHECK (status IN ('ACTIVE','REVOKED')),
      CHECK ((status='ACTIVE' AND revoked_at IS NULL AND revoked_by_account_id IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX clinic_service_doctor_assignments_active_unique ON clinic_service_doctor_assignments(service_offering_id,doctor_profile_id) WHERE status='ACTIVE';
    CREATE INDEX clinic_service_doctor_assignments_service_status ON clinic_service_doctor_assignments(service_offering_id,status);
    CREATE INDEX clinic_service_doctor_assignments_doctor_status ON clinic_service_doctor_assignments(doctor_profile_id,status);

    CREATE FUNCTION clinic_service_doctor_assignment_guard() RETURNS trigger AS $$
    DECLARE offering_clinic uuid; connection_clinic uuid; connection_doctor uuid; connection_status text; doctor_status text; verification_status text;
    BEGIN
      IF TG_OP='INSERT' AND NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'clinic service doctor assignment must be created active'; END IF;
      IF TG_OP='UPDATE' THEN
        IF (OLD.service_offering_id,OLD.doctor_profile_id,OLD.network_connection_id,OLD.created_at,OLD.created_by_account_id) IS DISTINCT FROM (NEW.service_offering_id,NEW.doctor_profile_id,NEW.network_connection_id,NEW.created_at,NEW.created_by_account_id) THEN RAISE EXCEPTION 'clinic service doctor assignment context is immutable'; END IF;
        IF OLD.status <> NEW.status AND NOT (OLD.status='ACTIVE' AND NEW.status='REVOKED') THEN RAISE EXCEPTION 'clinic service doctor assignment lifecycle transition is invalid'; END IF;
      END IF;
      IF NEW.status='ACTIVE' THEN
        SELECT owner_clinic_id INTO offering_clinic FROM service_offerings WHERE id=NEW.service_offering_id;
        SELECT clinic_left_id,doctor_profile_id,status INTO connection_clinic,connection_doctor,connection_status FROM network_connections WHERE id=NEW.network_connection_id AND connection_kind='CLINIC_DOCTOR';
        SELECT status,professional_verification_status INTO doctor_status,verification_status FROM doctor_profiles WHERE id=NEW.doctor_profile_id;
        IF offering_clinic IS NULL OR connection_clinic IS DISTINCT FROM offering_clinic OR connection_doctor IS DISTINCT FROM NEW.doctor_profile_id OR connection_status <> 'ACCEPTED' OR doctor_status <> 'ACTIVE' OR verification_status <> 'VERIFIED' THEN RAISE EXCEPTION 'clinic service doctor assignment relationship is invalid'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER clinic_service_doctor_assignment_integrity BEFORE INSERT OR UPDATE ON clinic_service_doctor_assignments FOR EACH ROW EXECUTE FUNCTION clinic_service_doctor_assignment_guard();
  `);
};

exports.down = (pgm) => pgm.sql(`
  DROP TRIGGER clinic_service_doctor_assignment_integrity ON clinic_service_doctor_assignments;
  DROP FUNCTION clinic_service_doctor_assignment_guard();
  DROP TABLE clinic_service_doctor_assignments;
`);

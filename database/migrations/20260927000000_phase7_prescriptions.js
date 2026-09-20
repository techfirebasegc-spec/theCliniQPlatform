/* theCliniQ Phase 7.1B: appointment-bound prescriptions. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE prescriptions (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
      patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      doctor_profile_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      draft_version integer NOT NULL DEFAULT 1,
      create_idempotency_key text NOT NULL,
      create_request_fingerprint text NOT NULL,
      issued_at timestamptz,
      issued_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      issue_idempotency_key text,
      issue_request_fingerprint text,
      final_snapshot jsonb,
      final_snapshot_hash text,
      CHECK (status IN ('DRAFT','ISSUED')),
      CHECK (draft_version > 0),
      CHECK (char_length(btrim(create_idempotency_key)) > 0),
      CHECK (char_length(btrim(create_request_fingerprint)) > 0),
      CHECK (
        (status='DRAFT' AND issued_at IS NULL AND issued_by_account_id IS NULL AND issue_idempotency_key IS NULL AND issue_request_fingerprint IS NULL AND final_snapshot IS NULL AND final_snapshot_hash IS NULL)
        OR
        (status='ISSUED' AND issued_at IS NOT NULL AND issued_by_account_id IS NOT NULL AND issue_idempotency_key IS NOT NULL AND char_length(btrim(issue_idempotency_key)) > 0 AND issue_request_fingerprint IS NOT NULL AND char_length(btrim(issue_request_fingerprint)) > 0 AND final_snapshot IS NOT NULL AND jsonb_typeof(final_snapshot)='object' AND final_snapshot_hash ~ '^[0-9a-f]{64}$')
      ),
      UNIQUE (created_by_account_id, create_idempotency_key)
    );
    CREATE UNIQUE INDEX prescriptions_issue_idempotency_unique
      ON prescriptions(issued_by_account_id, issue_idempotency_key)
      WHERE issued_by_account_id IS NOT NULL AND issue_idempotency_key IS NOT NULL;
    CREATE INDEX prescriptions_patient_issued ON prescriptions(patient_profile_id, issued_at DESC) WHERE status='ISSUED';
    CREATE INDEX prescriptions_doctor_status ON prescriptions(doctor_profile_id, status, updated_at DESC);

    CREATE TABLE prescription_items (
      id uuid PRIMARY KEY,
      prescription_id uuid NOT NULL REFERENCES prescriptions(id) ON DELETE RESTRICT,
      position integer NOT NULL,
      medicine_name text NOT NULL,
      strength text NOT NULL,
      dosage text NOT NULL,
      frequency text NOT NULL,
      duration text NOT NULL,
      route text,
      quantity text,
      instructions text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (position > 0),
      CHECK (char_length(btrim(medicine_name)) > 0),
      CHECK (char_length(btrim(strength)) > 0),
      CHECK (char_length(btrim(dosage)) > 0),
      CHECK (char_length(btrim(frequency)) > 0),
      CHECK (char_length(btrim(duration)) > 0),
      CHECK (route IS NULL OR char_length(btrim(route)) > 0),
      CHECK (quantity IS NULL OR char_length(btrim(quantity)) > 0),
      CHECK (instructions IS NULL OR char_length(btrim(instructions)) > 0),
      UNIQUE (prescription_id, position)
    );
    CREATE INDEX prescription_items_order ON prescription_items(prescription_id, position, id);

    CREATE FUNCTION prescription_mutation_guard() RETURNS trigger AS $$
    DECLARE appointment_status text;
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'prescription cannot be deleted';
      END IF;

      SELECT status INTO appointment_status FROM appointments WHERE id=NEW.appointment_id FOR UPDATE;
      IF appointment_status IS NULL THEN
        RAISE EXCEPTION 'prescription requires appointment';
      END IF;
      IF appointment_status NOT IN ('IN_PROGRESS','COMPLETED') THEN
        RAISE EXCEPTION 'prescription requires in-progress or completed appointment';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM appointment_participants participant
        WHERE participant.appointment_id=NEW.appointment_id
          AND participant.participant_type='PATIENT'
          AND participant.patient_profile_id=NEW.patient_profile_id
      ) OR NOT EXISTS (
        SELECT 1 FROM appointment_participants participant
        WHERE participant.appointment_id=NEW.appointment_id
          AND participant.participant_type='DOCTOR'
          AND participant.doctor_profile_id=NEW.doctor_profile_id
      ) THEN
        RAISE EXCEPTION 'prescription participants must match appointment participants';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM doctor_profiles WHERE id=NEW.doctor_profile_id AND account_id=NEW.created_by_account_id) THEN
        RAISE EXCEPTION 'prescription creator must own appointment doctor profile';
      END IF;
      IF NEW.status='ISSUED' AND NOT EXISTS (SELECT 1 FROM doctor_profiles WHERE id=NEW.doctor_profile_id AND account_id=NEW.issued_by_account_id) THEN
        RAISE EXCEPTION 'prescription issuer must own appointment doctor profile';
      END IF;

      IF TG_OP='INSERT' AND NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'prescription must be created as draft';
      END IF;

      IF TG_OP='UPDATE' THEN
        IF (OLD.appointment_id,OLD.patient_profile_id,OLD.doctor_profile_id,OLD.created_by_account_id,OLD.created_at,OLD.create_idempotency_key,OLD.create_request_fingerprint) IS DISTINCT FROM (NEW.appointment_id,NEW.patient_profile_id,NEW.doctor_profile_id,NEW.created_by_account_id,NEW.created_at,NEW.create_idempotency_key,NEW.create_request_fingerprint) THEN
          RAISE EXCEPTION 'prescription identity cannot be changed';
        END IF;
        IF OLD.status='ISSUED' THEN
          RAISE EXCEPTION 'issued prescription cannot be changed';
        END IF;
        IF OLD.status <> NEW.status AND NEW.status <> 'ISSUED' THEN
          RAISE EXCEPTION 'prescription status transition is invalid';
        END IF;
        IF NEW.status='ISSUED' AND NOT EXISTS (SELECT 1 FROM prescription_items WHERE prescription_id=NEW.id) THEN
          RAISE EXCEPTION 'issued prescription requires at least one item';
        END IF;
        NEW.updated_at=current_timestamp;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER prescriptions_mutation_integrity
      BEFORE INSERT OR UPDATE OR DELETE ON prescriptions
      FOR EACH ROW EXECUTE FUNCTION prescription_mutation_guard();

    CREATE FUNCTION prescription_item_mutation_guard() RETURNS trigger AS $$
    DECLARE target_prescription_id uuid;
    DECLARE appointment_status text;
    DECLARE prescription_status text;
    BEGIN
      target_prescription_id=CASE WHEN TG_OP='DELETE' THEN OLD.prescription_id ELSE NEW.prescription_id END;
      SELECT appointment.status,prescription.status INTO appointment_status,prescription_status
        FROM prescriptions prescription
        JOIN appointments appointment ON appointment.id=prescription.appointment_id
        WHERE prescription.id=target_prescription_id
        FOR UPDATE OF appointment,prescription;
      IF prescription_status IS NULL THEN
        RAISE EXCEPTION 'prescription item requires prescription';
      END IF;
      IF appointment_status NOT IN ('IN_PROGRESS','COMPLETED') THEN
        RAISE EXCEPTION 'prescription item requires in-progress or completed appointment';
      END IF;
      IF prescription_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'issued prescription items cannot be changed';
      END IF;
      IF TG_OP='UPDATE' THEN
        IF OLD.id <> NEW.id OR OLD.prescription_id <> NEW.prescription_id OR OLD.created_at <> NEW.created_at THEN
          RAISE EXCEPTION 'prescription item identity cannot be changed';
        END IF;
        NEW.updated_at=current_timestamp;
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER prescription_items_mutation_integrity
      BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
      FOR EACH ROW EXECUTE FUNCTION prescription_item_mutation_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM prescription_items) OR EXISTS (SELECT 1 FROM prescriptions) THEN
        RAISE EXCEPTION 'cannot roll back prescriptions while prescription records exist';
      END IF;
    END $$;
    DROP TRIGGER prescription_items_mutation_integrity ON prescription_items;
    DROP FUNCTION prescription_item_mutation_guard();
    DROP TRIGGER prescriptions_mutation_integrity ON prescriptions;
    DROP FUNCTION prescription_mutation_guard();
    DROP TABLE prescription_items;
    DROP TABLE prescriptions;
  `);
};

/* theCliniQ Phase 5.4: immutable Appointment participant evidence. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE appointment_participants (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
      participant_type text NOT NULL,
      patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (
        (participant_type = 'PATIENT' AND patient_profile_id IS NOT NULL AND doctor_profile_id IS NULL AND clinic_id IS NULL AND tenant_id IS NULL)
        OR (participant_type = 'DOCTOR' AND patient_profile_id IS NULL AND doctor_profile_id IS NOT NULL AND clinic_id IS NULL AND tenant_id IS NULL)
        OR (participant_type = 'CLINIC' AND patient_profile_id IS NULL AND doctor_profile_id IS NULL AND clinic_id IS NOT NULL AND tenant_id IS NOT NULL)
      ),
      CHECK (participant_type IN ('PATIENT','DOCTOR','CLINIC')),
      UNIQUE (appointment_id, participant_type)
    );
    CREATE INDEX appointment_participants_patient_appointment ON appointment_participants(patient_profile_id, appointment_id) WHERE participant_type = 'PATIENT';
    CREATE INDEX appointment_participants_doctor_appointment ON appointment_participants(doctor_profile_id, appointment_id) WHERE participant_type = 'DOCTOR';
    CREATE INDEX appointment_participants_clinic_tenant_appointment ON appointment_participants(clinic_id, tenant_id, appointment_id) WHERE participant_type = 'CLINIC';

    CREATE FUNCTION assert_appointment_participant_context(target_appointment_id uuid) RETURNS void AS $$
    DECLARE appointment_row appointments%ROWTYPE;
    DECLARE patient_count integer;
    DECLARE doctor_count integer;
    DECLARE clinic_count integer;
    BEGIN
      SELECT * INTO appointment_row FROM appointments WHERE id = target_appointment_id;
      IF appointment_row.id IS NULL THEN RETURN; END IF;
      SELECT count(*) FILTER (WHERE participant_type = 'PATIENT'),
             count(*) FILTER (WHERE participant_type = 'DOCTOR'),
             count(*) FILTER (WHERE participant_type = 'CLINIC')
        INTO patient_count, doctor_count, clinic_count
        FROM appointment_participants WHERE appointment_id = target_appointment_id;
      IF patient_count <> 1 THEN
        RAISE EXCEPTION 'appointment requires exactly one patient participant';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM appointment_participants participant
        JOIN patient_profiles patient ON patient.id = participant.patient_profile_id
        WHERE participant.appointment_id = target_appointment_id
          AND participant.participant_type = 'PATIENT'
          AND patient.account_id = appointment_row.patient_account_id
      ) THEN
        RAISE EXCEPTION 'appointment patient participant does not match appointment context';
      END IF;
      IF appointment_row.provider_doctor_profile_id IS NOT NULL THEN
        IF doctor_count <> 1 OR clinic_count <> 0 OR NOT EXISTS (
          SELECT 1 FROM appointment_participants participant
          WHERE participant.appointment_id = target_appointment_id
            AND participant.participant_type = 'DOCTOR'
            AND participant.doctor_profile_id = appointment_row.provider_doctor_profile_id
        ) THEN
          RAISE EXCEPTION 'appointment doctor participant does not match appointment context';
        END IF;
      ELSE
        IF clinic_count <> 1 OR doctor_count <> 0 OR NOT EXISTS (
          SELECT 1 FROM appointment_participants participant
          JOIN clinics clinic ON clinic.id = participant.clinic_id
          WHERE participant.appointment_id = target_appointment_id
            AND participant.participant_type = 'CLINIC'
            AND participant.clinic_id = appointment_row.provider_clinic_id
            AND participant.tenant_id = clinic.tenant_id
            AND participant.tenant_id = appointment_row.booking_tenant_id
        ) THEN
          RAISE EXCEPTION 'appointment clinic participant does not match appointment context';
        END IF;
      END IF;
    END; $$ LANGUAGE plpgsql;

    CREATE FUNCTION appointment_participant_context_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM assert_appointment_participant_context(OLD.appointment_id);
      ELSE
        PERFORM assert_appointment_participant_context(NEW.appointment_id);
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE FUNCTION appointment_participant_completeness_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM assert_appointment_participant_context(OLD.id);
      ELSE
        PERFORM assert_appointment_participant_context(NEW.id);
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER appointment_participants_context_integrity
      AFTER INSERT OR UPDATE OR DELETE ON appointment_participants
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_participant_context_guard();
    CREATE CONSTRAINT TRIGGER appointments_participant_completeness_integrity
      AFTER INSERT OR UPDATE ON appointments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_participant_completeness_guard();

    CREATE FUNCTION appointment_participant_immutable_guard() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'appointment participant cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_participants_immutable
      BEFORE UPDATE OR DELETE ON appointment_participants
      FOR EACH ROW EXECUTE FUNCTION appointment_participant_immutable_guard();

    INSERT INTO appointment_participants (id, appointment_id, participant_type, patient_profile_id)
      SELECT gen_random_uuid(), appointment.id, 'PATIENT', patient.id
      FROM appointments appointment
      JOIN patient_profiles patient ON patient.account_id = appointment.patient_account_id;
    INSERT INTO appointment_participants (id, appointment_id, participant_type, doctor_profile_id)
      SELECT gen_random_uuid(), appointment.id, 'DOCTOR', appointment.provider_doctor_profile_id
      FROM appointments appointment
      WHERE appointment.provider_doctor_profile_id IS NOT NULL;
    INSERT INTO appointment_participants (id, appointment_id, participant_type, clinic_id, tenant_id)
      SELECT gen_random_uuid(), appointment.id, 'CLINIC', clinic.id, clinic.tenant_id
      FROM appointments appointment
      JOIN clinics clinic ON clinic.id = appointment.provider_clinic_id
      WHERE appointment.provider_clinic_id IS NOT NULL;
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM appointments appointment
        WHERE NOT EXISTS (
          SELECT 1 FROM appointment_participants participant
          WHERE participant.appointment_id = appointment.id AND participant.participant_type = 'PATIENT'
        )
      ) THEN RAISE EXCEPTION 'cannot add appointment participants without patient profile evidence'; END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointment_participants) THEN
        RAISE EXCEPTION 'cannot roll back appointment participants while participant records exist';
      END IF;
    END $$;
    DROP TRIGGER appointments_participant_completeness_integrity ON appointments;
    DROP FUNCTION appointment_participant_completeness_guard();
    DROP TRIGGER appointment_participants_immutable ON appointment_participants;
    DROP FUNCTION appointment_participant_immutable_guard();
    DROP TRIGGER appointment_participants_context_integrity ON appointment_participants;
    DROP FUNCTION appointment_participant_context_guard();
    DROP FUNCTION assert_appointment_participant_context(uuid);
    DROP TABLE appointment_participants;
  `);
};

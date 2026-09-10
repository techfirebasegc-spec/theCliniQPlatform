/* theCliniQ Phase 5 Step 5.1: immutable Appointment and Appointment Event foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE appointments (
      id uuid PRIMARY KEY,
      appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      slot_reservation_id uuid NOT NULL UNIQUE REFERENCES slot_reservations(id) ON DELETE RESTRICT,
      appointment_financial_handoff_id uuid NOT NULL UNIQUE REFERENCES appointment_financial_handoffs(id) ON DELETE RESTRICT,
      financial_allocation_snapshot_id uuid NOT NULL UNIQUE REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      payment_intent_id uuid NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE RESTRICT,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      provider_doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      provider_clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      service_exposure_id uuid NOT NULL REFERENCES service_exposures(id) ON DELETE RESTRICT,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      service_offering_price_id uuid NOT NULL REFERENCES service_offering_prices(id) ON DELETE RESTRICT,
      currency char(3) NOT NULL,
      price_amount_minor bigint NOT NULL,
      provider_timezone text NOT NULL,
      requested_local_at timestamp NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      service_duration_seconds integer NOT NULL,
      buffer_before_seconds integer NOT NULL,
      buffer_after_seconds integer NOT NULL,
      hold_seconds integer NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK ((provider_doctor_profile_id IS NOT NULL AND provider_clinic_id IS NULL) OR (provider_doctor_profile_id IS NULL AND provider_clinic_id IS NOT NULL)),
      CHECK (currency ~ '^[A-Z]{3}$'),
      CHECK (price_amount_minor >= 0),
      CHECK (char_length(btrim(provider_timezone)) > 0),
      CHECK (ends_at > starts_at),
      CHECK (service_duration_seconds > 0),
      CHECK (buffer_before_seconds >= 0),
      CHECK (buffer_after_seconds >= 0),
      CHECK (hold_seconds > 0),
      CHECK (status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'))
    );
    CREATE INDEX appointments_patient_state ON appointments(patient_account_id,status,starts_at);
    CREATE INDEX appointments_provider_state ON appointments(provider_doctor_profile_id,provider_clinic_id,status,starts_at);

    CREATE TABLE appointment_events (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
      event_type text NOT NULL,
      actor_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      previous_status text,
      resulting_status text,
      occurred_at timestamptz NOT NULL DEFAULT current_timestamp,
      reason text,
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      audit_event_id uuid REFERENCES audit_events(id) ON DELETE RESTRICT,
      CHECK (event_type IN ('CONFIRMED','STARTED','COMPLETED','CANCELLED','RESCHEDULE_REQUESTED','RESCHEDULED','EXPIRED','PAYMENT_FAILED','SUPPORT_EXCEPTION')),
      CHECK (previous_status IS NULL OR previous_status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED')),
      CHECK (resulting_status IS NULL OR resulting_status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED')),
      CHECK (jsonb_typeof(context) = 'object')
    );
    CREATE INDEX appointment_events_appointment_occurred ON appointment_events(appointment_id,occurred_at,id);

    CREATE FUNCTION appointment_context_guard() RETURNS trigger AS $$
    DECLARE intent_row appointment_intents%ROWTYPE;
    DECLARE reservation_row slot_reservations%ROWTYPE;
    DECLARE handoff_row appointment_financial_handoffs%ROWTYPE;
    DECLARE allocation_row financial_allocation_snapshots%ROWTYPE;
    DECLARE payment_row payment_intents%ROWTYPE;
    BEGIN
      SELECT * INTO intent_row FROM appointment_intents WHERE id=NEW.appointment_intent_id;
      SELECT * INTO reservation_row FROM slot_reservations WHERE id=NEW.slot_reservation_id;
      SELECT * INTO handoff_row FROM appointment_financial_handoffs WHERE id=NEW.appointment_financial_handoff_id;
      SELECT * INTO allocation_row FROM financial_allocation_snapshots WHERE id=NEW.financial_allocation_snapshot_id;
      SELECT * INTO payment_row FROM payment_intents WHERE id=NEW.payment_intent_id;
      IF intent_row.id IS NULL OR reservation_row.id IS NULL OR handoff_row.id IS NULL OR allocation_row.id IS NULL OR payment_row.id IS NULL THEN
        RAISE EXCEPTION 'appointment context is inconsistent';
      END IF;
      IF intent_row.state <> 'PAYMENT_PENDING'
        OR reservation_row.appointment_intent_id IS DISTINCT FROM intent_row.id
        OR handoff_row.appointment_intent_id IS DISTINCT FROM intent_row.id
        OR handoff_row.slot_reservation_id IS DISTINCT FROM reservation_row.id
        OR handoff_row.financial_allocation_snapshot_id IS DISTINCT FROM allocation_row.id
        OR handoff_row.payment_intent_id IS DISTINCT FROM payment_row.id
        OR payment_row.allocation_snapshot_id IS DISTINCT FROM allocation_row.id
        OR payment_row.status <> 'SUCCEEDED'
        OR intent_row.patient_account_id IS DISTINCT FROM NEW.patient_account_id
        OR intent_row.booking_actor_account_id IS DISTINCT FROM NEW.booking_actor_account_id
        OR intent_row.booking_tenant_id IS DISTINCT FROM NEW.booking_tenant_id
        OR intent_row.provider_doctor_profile_id IS DISTINCT FROM NEW.provider_doctor_profile_id
        OR intent_row.provider_clinic_id IS DISTINCT FROM NEW.provider_clinic_id
        OR intent_row.service_exposure_id IS DISTINCT FROM NEW.service_exposure_id
        OR intent_row.service_offering_id IS DISTINCT FROM NEW.service_offering_id
        OR intent_row.service_offering_version_id IS DISTINCT FROM NEW.service_offering_version_id
        OR intent_row.service_offering_price_id IS DISTINCT FROM NEW.service_offering_price_id
        OR intent_row.currency IS DISTINCT FROM NEW.currency
        OR intent_row.price_amount_minor IS DISTINCT FROM NEW.price_amount_minor
        OR intent_row.provider_timezone IS DISTINCT FROM NEW.provider_timezone
        OR intent_row.requested_local_at IS DISTINCT FROM NEW.requested_local_at
        OR intent_row.starts_at IS DISTINCT FROM NEW.starts_at
        OR intent_row.ends_at IS DISTINCT FROM NEW.ends_at
        OR intent_row.service_duration_seconds IS DISTINCT FROM NEW.service_duration_seconds
        OR intent_row.buffer_before_seconds IS DISTINCT FROM NEW.buffer_before_seconds
        OR intent_row.buffer_after_seconds IS DISTINCT FROM NEW.buffer_after_seconds
        OR intent_row.hold_seconds IS DISTINCT FROM NEW.hold_seconds THEN
        RAISE EXCEPTION 'appointment context is inconsistent';
      END IF;
      IF TG_OP='UPDATE' AND (OLD.appointment_intent_id,OLD.slot_reservation_id,OLD.appointment_financial_handoff_id,OLD.financial_allocation_snapshot_id,OLD.payment_intent_id,OLD.patient_account_id,OLD.booking_actor_account_id,OLD.booking_tenant_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.service_exposure_id,OLD.service_offering_id,OLD.service_offering_version_id,OLD.service_offering_price_id,OLD.currency,OLD.price_amount_minor,OLD.provider_timezone,OLD.requested_local_at,OLD.starts_at,OLD.ends_at,OLD.service_duration_seconds,OLD.buffer_before_seconds,OLD.buffer_after_seconds,OLD.hold_seconds,OLD.created_at) IS DISTINCT FROM (NEW.appointment_intent_id,NEW.slot_reservation_id,NEW.appointment_financial_handoff_id,NEW.financial_allocation_snapshot_id,NEW.payment_intent_id,NEW.patient_account_id,NEW.booking_actor_account_id,NEW.booking_tenant_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds,NEW.created_at) THEN
        RAISE EXCEPTION 'appointment historical context is immutable';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_context_integrity BEFORE INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_context_guard();

    CREATE FUNCTION appointment_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.status <> NEW.status AND NOT (
        (OLD.status='CONFIRMED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
        (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
      ) THEN
        RAISE EXCEPTION 'appointment state transition is invalid';
      END IF;
      NEW.updated_at = current_timestamp;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_state_integrity BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_state_guard();

    CREATE FUNCTION appointment_event_guard() RETURNS trigger AS $$
    DECLARE appointment_status text;
    BEGIN
      SELECT status INTO appointment_status FROM appointments WHERE id=NEW.appointment_id;
      IF appointment_status IS NULL THEN RAISE EXCEPTION 'appointment event requires appointment'; END IF;
      IF (NEW.event_type='CONFIRMED' AND NOT (NEW.previous_status IS NULL AND NEW.resulting_status='CONFIRMED'))
        OR (NEW.event_type='STARTED' AND NOT (NEW.previous_status='CONFIRMED' AND NEW.resulting_status='IN_PROGRESS'))
        OR (NEW.event_type='COMPLETED' AND NOT (NEW.previous_status='IN_PROGRESS' AND NEW.resulting_status='COMPLETED'))
        OR (NEW.event_type='CANCELLED' AND NOT (NEW.previous_status IN ('CONFIRMED','IN_PROGRESS') AND NEW.resulting_status='CANCELLED'))
        OR (NEW.event_type='EXPIRED' AND NOT (NEW.resulting_status='EXPIRED'))
        OR (NEW.event_type='PAYMENT_FAILED' AND NOT (NEW.resulting_status='PAYMENT_FAILED'))
        OR (NEW.event_type IN ('RESCHEDULE_REQUESTED','RESCHEDULED','SUPPORT_EXCEPTION') AND NEW.resulting_status IS NOT NULL) THEN
        RAISE EXCEPTION 'appointment event transition is invalid';
      END IF;
      IF NEW.resulting_status IS NOT NULL AND NEW.resulting_status IS DISTINCT FROM appointment_status THEN
        RAISE EXCEPTION 'appointment event resulting state is inconsistent';
      END IF;
      IF NEW.event_type='SUPPORT_EXCEPTION' AND (NEW.reason IS NULL OR char_length(btrim(NEW.reason))=0) THEN
        RAISE EXCEPTION 'support appointment event requires reason';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_event_transition_integrity BEFORE INSERT ON appointment_events FOR EACH ROW EXECUTE FUNCTION appointment_event_guard();

    CREATE FUNCTION appointment_event_immutable_guard() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'appointment event cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_events_immutable BEFORE UPDATE OR DELETE ON appointment_events FOR EACH ROW EXECUTE FUNCTION appointment_event_immutable_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointment_events) OR EXISTS (SELECT 1 FROM appointments) THEN
        RAISE EXCEPTION 'cannot roll back appointment foundation while appointment records exist';
      END IF;
    END $$;
    DROP TRIGGER appointment_events_immutable ON appointment_events;
    DROP FUNCTION appointment_event_immutable_guard();
    DROP TRIGGER appointment_event_transition_integrity ON appointment_events;
    DROP FUNCTION appointment_event_guard();
    DROP TRIGGER appointment_state_integrity ON appointments;
    DROP FUNCTION appointment_state_guard();
    DROP TRIGGER appointment_context_integrity ON appointments;
    DROP FUNCTION appointment_context_guard();
    DROP TABLE appointment_events;
    DROP TABLE appointments;
  `);
};

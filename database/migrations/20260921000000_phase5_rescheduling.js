/* theCliniQ Phase 5.6: immutable reschedule history and committed appointment capacity. */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_state_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_state_check
      CHECK (state IN ('APPOINTMENT_INTENT','SLOT_RESERVED','PAYMENT_PENDING','FULFILLED','EXPIRED','CANCELLED'));

    CREATE TABLE appointment_committed_capacities (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
      slot_reservation_id uuid NOT NULL UNIQUE REFERENCES slot_reservations(id) ON DELETE RESTRICT,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      capacity_units integer NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE',
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (ends_at > starts_at), CHECK (capacity_units > 0),
      CHECK ((status='ACTIVE' AND released_at IS NULL) OR (status='RELEASED' AND released_at IS NOT NULL))
    );
    CREATE INDEX appointment_committed_capacities_active_lookup
      ON appointment_committed_capacities(service_offering_version_id,starts_at,ends_at)
      WHERE status='ACTIVE';
    -- Preserve capacity represented by already-confirmed pre-Phase-5.6 appointments.
    INSERT INTO appointment_committed_capacities (id,appointment_id,slot_reservation_id,service_offering_version_id,starts_at,ends_at,capacity_units)
      SELECT gen_random_uuid(),appointment.id,reservation.id,reservation.service_offering_version_id,reservation.starts_at,reservation.ends_at,reservation.capacity_units
      FROM appointments appointment JOIN slot_reservations reservation ON reservation.id=appointment.slot_reservation_id
      WHERE appointment.status IN ('CONFIRMED','IN_PROGRESS')
      ON CONFLICT (appointment_id) DO NOTHING;
    CREATE FUNCTION appointment_committed_capacity_immutable_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.appointment_id,OLD.slot_reservation_id,OLD.service_offering_version_id,OLD.starts_at,OLD.ends_at,OLD.capacity_units,OLD.created_at) IS DISTINCT FROM (NEW.appointment_id,NEW.slot_reservation_id,NEW.service_offering_version_id,NEW.starts_at,NEW.ends_at,NEW.capacity_units,NEW.created_at) THEN RAISE EXCEPTION 'appointment committed capacity context is immutable'; END IF;
      IF TG_OP='UPDATE' AND OLD.status='RELEASED' AND NEW.status <> 'RELEASED' THEN RAISE EXCEPTION 'released appointment committed capacity cannot reactivate'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_committed_capacity_immutable BEFORE UPDATE OR DELETE ON appointment_committed_capacities FOR EACH ROW EXECUTE FUNCTION appointment_committed_capacity_immutable_guard();

    ALTER TABLE appointments ADD COLUMN reschedule_source_appointment_id uuid REFERENCES appointments(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX appointments_reschedule_source_once ON appointments(reschedule_source_appointment_id) WHERE reschedule_source_appointment_id IS NOT NULL;
    ALTER TABLE appointments DROP CONSTRAINT appointments_appointment_financial_handoff_id_key;
    ALTER TABLE appointments DROP CONSTRAINT appointments_financial_allocation_snapshot_id_key;
    ALTER TABLE appointments DROP CONSTRAINT appointments_payment_intent_id_key;
    CREATE UNIQUE INDEX appointments_financial_handoff_ordinary_once ON appointments(appointment_financial_handoff_id) WHERE reschedule_source_appointment_id IS NULL;
    CREATE UNIQUE INDEX appointments_allocation_ordinary_once ON appointments(financial_allocation_snapshot_id) WHERE reschedule_source_appointment_id IS NULL;
    CREATE UNIQUE INDEX appointments_payment_intent_ordinary_once ON appointments(payment_intent_id) WHERE reschedule_source_appointment_id IS NULL;

    CREATE OR REPLACE FUNCTION appointment_context_guard() RETURNS trigger AS $$
    DECLARE intent_row appointment_intents%ROWTYPE; reservation_row slot_reservations%ROWTYPE; handoff_row appointment_financial_handoffs%ROWTYPE; allocation_row financial_allocation_snapshots%ROWTYPE; payment_row payment_intents%ROWTYPE; source_row appointments%ROWTYPE;
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.appointment_intent_id,OLD.slot_reservation_id,OLD.appointment_financial_handoff_id,OLD.financial_allocation_snapshot_id,OLD.payment_intent_id,OLD.patient_account_id,OLD.booking_actor_account_id,OLD.booking_tenant_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.service_exposure_id,OLD.service_offering_id,OLD.service_offering_version_id,OLD.service_offering_price_id,OLD.currency,OLD.price_amount_minor,OLD.provider_timezone,OLD.requested_local_at,OLD.starts_at,OLD.ends_at,OLD.service_duration_seconds,OLD.buffer_before_seconds,OLD.buffer_after_seconds,OLD.hold_seconds,OLD.reschedule_source_appointment_id,OLD.created_at) IS DISTINCT FROM (NEW.appointment_intent_id,NEW.slot_reservation_id,NEW.appointment_financial_handoff_id,NEW.financial_allocation_snapshot_id,NEW.payment_intent_id,NEW.patient_account_id,NEW.booking_actor_account_id,NEW.booking_tenant_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds,NEW.reschedule_source_appointment_id,NEW.created_at) THEN RAISE EXCEPTION 'appointment historical context is immutable'; END IF;
      SELECT * INTO intent_row FROM appointment_intents WHERE id=NEW.appointment_intent_id;
      SELECT * INTO reservation_row FROM slot_reservations WHERE id=NEW.slot_reservation_id;
      SELECT * INTO handoff_row FROM appointment_financial_handoffs WHERE id=NEW.appointment_financial_handoff_id;
      SELECT * INTO allocation_row FROM financial_allocation_snapshots WHERE id=NEW.financial_allocation_snapshot_id;
      SELECT * INTO payment_row FROM payment_intents WHERE id=NEW.payment_intent_id;
      IF intent_row.id IS NULL OR reservation_row.id IS NULL OR handoff_row.id IS NULL OR allocation_row.id IS NULL OR payment_row.id IS NULL THEN RAISE EXCEPTION 'appointment context is inconsistent'; END IF;
      IF NEW.reschedule_source_appointment_id IS NOT NULL THEN
        SELECT * INTO source_row FROM appointments WHERE id=NEW.reschedule_source_appointment_id;
        IF source_row.id IS NULL OR source_row.status <> 'CONFIRMED' OR intent_row.state <> 'SLOT_RESERVED'
          OR reservation_row.appointment_intent_id IS DISTINCT FROM intent_row.id
          OR (source_row.appointment_financial_handoff_id,source_row.financial_allocation_snapshot_id,source_row.payment_intent_id) IS DISTINCT FROM (NEW.appointment_financial_handoff_id,NEW.financial_allocation_snapshot_id,NEW.payment_intent_id)
          OR (source_row.patient_account_id,source_row.booking_actor_account_id,source_row.booking_tenant_id,source_row.provider_doctor_profile_id,source_row.provider_clinic_id,source_row.service_exposure_id,source_row.service_offering_id,source_row.service_offering_version_id,source_row.service_offering_price_id,source_row.currency,source_row.price_amount_minor,source_row.provider_timezone,source_row.service_duration_seconds,source_row.buffer_before_seconds,source_row.buffer_after_seconds)
             IS DISTINCT FROM (NEW.patient_account_id,NEW.booking_actor_account_id,NEW.booking_tenant_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds)
        THEN RAISE EXCEPTION 'reschedule successor appointment context is inconsistent'; END IF;
        RETURN NEW;
      END IF;
      IF intent_row.state <> 'PAYMENT_PENDING' OR reservation_row.appointment_intent_id IS DISTINCT FROM intent_row.id OR handoff_row.appointment_intent_id IS DISTINCT FROM intent_row.id OR handoff_row.slot_reservation_id IS DISTINCT FROM reservation_row.id OR handoff_row.financial_allocation_snapshot_id IS DISTINCT FROM allocation_row.id OR handoff_row.payment_intent_id IS DISTINCT FROM payment_row.id OR payment_row.allocation_snapshot_id IS DISTINCT FROM allocation_row.id OR payment_row.status <> 'SUCCEEDED' OR (intent_row.patient_account_id,intent_row.booking_actor_account_id,intent_row.booking_tenant_id,intent_row.provider_doctor_profile_id,intent_row.provider_clinic_id,intent_row.service_exposure_id,intent_row.service_offering_id,intent_row.service_offering_version_id,intent_row.service_offering_price_id,intent_row.currency,intent_row.price_amount_minor,intent_row.provider_timezone,intent_row.requested_local_at,intent_row.starts_at,intent_row.ends_at,intent_row.service_duration_seconds,intent_row.buffer_before_seconds,intent_row.buffer_after_seconds,intent_row.hold_seconds) IS DISTINCT FROM (NEW.patient_account_id,NEW.booking_actor_account_id,NEW.booking_tenant_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds) THEN RAISE EXCEPTION 'appointment context is inconsistent'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    CREATE TABLE appointment_reschedules (
      id uuid PRIMARY KEY,
      source_appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
      successor_appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      successor_appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      successor_slot_reservation_id uuid NOT NULL UNIQUE REFERENCES slot_reservations(id) ON DELETE RESTRICT,
      actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      reason text NOT NULL CHECK (char_length(btrim(reason)) > 0),
      idempotency_key text NOT NULL CHECK (char_length(btrim(idempotency_key)) > 0),
      request_fingerprint text NOT NULL CHECK (char_length(btrim(request_fingerprint)) > 0),
      audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      UNIQUE(actor_account_id,idempotency_key)
    );
    CREATE FUNCTION appointment_reschedule_immutable_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'appointment reschedule evidence cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_reschedules_immutable BEFORE UPDATE OR DELETE ON appointment_reschedules FOR EACH ROW EXECUTE FUNCTION appointment_reschedule_immutable_guard();

    CREATE OR REPLACE FUNCTION appointment_intent_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.state <> NEW.state AND NOT (
        (OLD.state='APPOINTMENT_INTENT' AND NEW.state IN ('SLOT_RESERVED','EXPIRED','CANCELLED')) OR
        (OLD.state='SLOT_RESERVED' AND NEW.state IN ('PAYMENT_PENDING','FULFILLED','EXPIRED','CANCELLED')) OR
        (OLD.state='PAYMENT_PENDING' AND NEW.state='EXPIRED')
      ) THEN RAISE EXCEPTION 'appointment intent state transition is invalid'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    CREATE FUNCTION appointment_intent_fulfilled_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.state='FULFILLED' AND NOT EXISTS (SELECT 1 FROM appointment_reschedules r WHERE r.successor_appointment_intent_id=NEW.id) THEN RAISE EXCEPTION 'only a reschedule successor intent may be fulfilled'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_intent_fulfilled_integrity AFTER INSERT OR UPDATE OF state ON appointment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointment_intent_fulfilled_guard();

    CREATE FUNCTION appointment_reschedule_context_guard() RETURNS trigger AS $$
    DECLARE source_row appointments%ROWTYPE; successor_row appointments%ROWTYPE; intent_row appointment_intents%ROWTYPE; reservation_row slot_reservations%ROWTYPE;
    BEGIN
      SELECT * INTO source_row FROM appointments WHERE id=NEW.source_appointment_id;
      SELECT * INTO successor_row FROM appointments WHERE id=NEW.successor_appointment_id;
      SELECT * INTO intent_row FROM appointment_intents WHERE id=NEW.successor_appointment_intent_id;
      SELECT * INTO reservation_row FROM slot_reservations WHERE id=NEW.successor_slot_reservation_id;
      IF source_row.id IS NULL OR successor_row.id IS NULL OR intent_row.id IS NULL OR reservation_row.id IS NULL
        OR source_row.status <> 'CONFIRMED' OR successor_row.status <> 'CONFIRMED' OR intent_row.state <> 'FULFILLED'
        OR successor_row.reschedule_source_appointment_id IS DISTINCT FROM source_row.id
        OR successor_row.appointment_intent_id IS DISTINCT FROM intent_row.id OR successor_row.slot_reservation_id IS DISTINCT FROM reservation_row.id
        OR reservation_row.appointment_intent_id IS DISTINCT FROM intent_row.id
        OR (source_row.provider_doctor_profile_id,source_row.provider_clinic_id,source_row.booking_tenant_id,source_row.service_exposure_id,source_row.service_offering_id,source_row.service_offering_version_id,source_row.service_offering_price_id,source_row.currency,source_row.price_amount_minor,source_row.service_duration_seconds,source_row.buffer_before_seconds,source_row.buffer_after_seconds)
           IS DISTINCT FROM (successor_row.provider_doctor_profile_id,successor_row.provider_clinic_id,successor_row.booking_tenant_id,successor_row.service_exposure_id,successor_row.service_offering_id,successor_row.service_offering_version_id,successor_row.service_offering_price_id,successor_row.currency,successor_row.price_amount_minor,successor_row.service_duration_seconds,successor_row.buffer_before_seconds,successor_row.buffer_after_seconds)
        OR (source_row.appointment_financial_handoff_id,source_row.financial_allocation_snapshot_id,source_row.payment_intent_id) IS DISTINCT FROM (successor_row.appointment_financial_handoff_id,successor_row.financial_allocation_snapshot_id,successor_row.payment_intent_id)
        OR NOT EXISTS (SELECT 1 FROM appointment_committed_capacities c WHERE c.appointment_id=successor_row.id AND c.slot_reservation_id=reservation_row.id AND c.status='ACTIVE')
      THEN RAISE EXCEPTION 'appointment reschedule context is inconsistent'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_reschedule_context_integrity AFTER INSERT ON appointment_reschedules DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointment_reschedule_context_guard();

    CREATE FUNCTION appointment_successor_reschedule_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.reschedule_source_appointment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM appointment_reschedules r
        JOIN appointment_intents intent ON intent.id=r.successor_appointment_intent_id
        JOIN appointment_committed_capacities capacity ON capacity.appointment_id=NEW.id AND capacity.slot_reservation_id=NEW.slot_reservation_id AND capacity.status='ACTIVE'
        WHERE r.source_appointment_id=NEW.reschedule_source_appointment_id AND r.successor_appointment_id=NEW.id AND r.successor_appointment_intent_id=NEW.appointment_intent_id AND r.successor_slot_reservation_id=NEW.slot_reservation_id AND intent.state='FULFILLED'
      ) THEN RAISE EXCEPTION 'successor appointment requires a valid fulfilled reschedule relationship'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_successor_reschedule_integrity AFTER INSERT OR UPDATE OF reschedule_source_appointment_id ON appointments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointment_successor_reschedule_guard();

    CREATE FUNCTION appointment_confirmed_capacity_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM appointment_committed_capacities c WHERE c.appointment_id=NEW.id AND c.slot_reservation_id=NEW.slot_reservation_id AND c.status='ACTIVE') THEN RAISE EXCEPTION 'confirmed appointment requires active committed capacity'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_confirmed_capacity_integrity AFTER INSERT OR UPDATE OF status ON appointments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointment_confirmed_capacity_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM appointment_reschedules) OR EXISTS (SELECT 1 FROM appointment_committed_capacities) OR EXISTS (SELECT 1 FROM appointment_intents WHERE state='FULFILLED') THEN RAISE EXCEPTION 'cannot roll back rescheduling while reschedule history exists'; END IF; END $$;
    DROP TRIGGER appointment_confirmed_capacity_integrity ON appointments; DROP FUNCTION appointment_confirmed_capacity_guard();
    DROP TRIGGER appointment_successor_reschedule_integrity ON appointments; DROP FUNCTION appointment_successor_reschedule_guard();
    DROP TRIGGER appointment_intent_fulfilled_integrity ON appointment_intents; DROP FUNCTION appointment_intent_fulfilled_guard();
    DROP TRIGGER appointment_reschedule_context_integrity ON appointment_reschedules; DROP FUNCTION appointment_reschedule_context_guard();
    DROP TRIGGER appointment_reschedules_immutable ON appointment_reschedules; DROP FUNCTION appointment_reschedule_immutable_guard(); DROP TABLE appointment_reschedules;
    DROP INDEX appointments_payment_intent_ordinary_once; DROP INDEX appointments_allocation_ordinary_once; DROP INDEX appointments_financial_handoff_ordinary_once; ALTER TABLE appointments ADD CONSTRAINT appointments_appointment_financial_handoff_id_key UNIQUE(appointment_financial_handoff_id); ALTER TABLE appointments ADD CONSTRAINT appointments_financial_allocation_snapshot_id_key UNIQUE(financial_allocation_snapshot_id); ALTER TABLE appointments ADD CONSTRAINT appointments_payment_intent_id_key UNIQUE(payment_intent_id); DROP INDEX appointments_reschedule_source_once; ALTER TABLE appointments DROP COLUMN reschedule_source_appointment_id;
    DROP TRIGGER appointment_committed_capacity_immutable ON appointment_committed_capacities; DROP FUNCTION appointment_committed_capacity_immutable_guard(); DROP TABLE appointment_committed_capacities;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_state_check; ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_state_check CHECK (state IN ('APPOINTMENT_INTENT','SLOT_RESERVED','PAYMENT_PENDING','EXPIRED','CANCELLED'));
  `);
};

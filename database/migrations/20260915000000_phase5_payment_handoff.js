/* theCliniQ Phase 5 Step 4: direct-patient payment handoff foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_state_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_state_check
      CHECK (state IN ('APPOINTMENT_INTENT','SLOT_RESERVED','PAYMENT_PENDING','EXPIRED','CANCELLED'));

    CREATE TABLE appointment_financial_handoffs (
      id uuid PRIMARY KEY,
      appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      slot_reservation_id uuid NOT NULL UNIQUE REFERENCES slot_reservations(id) ON DELETE RESTRICT,
      financial_allocation_snapshot_id uuid NOT NULL UNIQUE REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      payment_intent_id uuid NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE RESTRICT,
      booking_actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      idempotency_key text NOT NULL,
      request_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (char_length(btrim(idempotency_key)) > 0),
      CHECK (char_length(btrim(request_fingerprint)) > 0)
    );

    CREATE FUNCTION financial_allocation_component_immutable_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'financial allocation component cannot be changed';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER financial_allocation_components_immutable
      BEFORE UPDATE OR DELETE ON financial_allocation_components
      FOR EACH ROW EXECUTE FUNCTION financial_allocation_component_immutable_guard();

    CREATE FUNCTION appointment_intent_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.state <> NEW.state AND NOT (
        (OLD.state = 'APPOINTMENT_INTENT' AND NEW.state IN ('SLOT_RESERVED','EXPIRED')) OR
        (OLD.state = 'SLOT_RESERVED' AND NEW.state IN ('PAYMENT_PENDING','EXPIRED')) OR
        (OLD.state = 'PAYMENT_PENDING' AND NEW.state = 'EXPIRED')
      ) THEN
        RAISE EXCEPTION 'appointment intent state transition is invalid';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_intent_state_integrity
      BEFORE UPDATE OF state ON appointment_intents
      FOR EACH ROW EXECUTE FUNCTION appointment_intent_state_guard();

    CREATE FUNCTION appointment_financial_handoff_guard() RETURNS trigger AS $$
    DECLARE intent_row appointment_intents%ROWTYPE;
    DECLARE reservation_row slot_reservations%ROWTYPE;
    DECLARE allocation_row financial_allocation_snapshots%ROWTYPE;
    DECLARE payment_row payment_intents%ROWTYPE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'appointment financial handoff cannot be deleted';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'appointment financial handoff cannot be changed';
      END IF;

      SELECT * INTO intent_row FROM appointment_intents WHERE id = NEW.appointment_intent_id;
      SELECT * INTO reservation_row FROM slot_reservations WHERE id = NEW.slot_reservation_id;
      SELECT * INTO allocation_row FROM financial_allocation_snapshots WHERE id = NEW.financial_allocation_snapshot_id;
      SELECT * INTO payment_row FROM payment_intents WHERE id = NEW.payment_intent_id;

      IF NOT FOUND OR intent_row.id IS NULL OR reservation_row.id IS NULL OR allocation_row.id IS NULL OR payment_row.id IS NULL THEN
        RAISE EXCEPTION 'appointment financial handoff context is inconsistent';
      END IF;
      IF intent_row.booking_relationship <> 'PATIENT_PROVIDER'
        OR intent_row.patient_account_id IS DISTINCT FROM NEW.booking_actor_account_id
        OR intent_row.booking_actor_account_id IS DISTINCT FROM NEW.booking_actor_account_id
        OR reservation_row.appointment_intent_id IS DISTINCT FROM intent_row.id
        OR reservation_row.status <> 'HELD'
        OR allocation_row.status <> 'FINAL'
        OR allocation_row.currency IS DISTINCT FROM intent_row.currency
        OR allocation_row.gross_amount_minor IS DISTINCT FROM intent_row.price_amount_minor
        OR payment_row.allocation_snapshot_id IS DISTINCT FROM allocation_row.id
        OR payment_row.status <> 'CREATED'
        OR payment_row.currency IS DISTINCT FROM allocation_row.currency
        OR payment_row.amount_minor IS DISTINCT FROM allocation_row.gross_amount_minor
        OR allocation_row.input_data ->> 'appointmentIntentId' IS DISTINCT FROM intent_row.id::text
        OR allocation_row.input_data ->> 'slotReservationId' IS DISTINCT FROM reservation_row.id::text
        OR allocation_row.input_data ->> 'serviceExposureId' IS DISTINCT FROM intent_row.service_exposure_id::text
        OR allocation_row.input_data ->> 'serviceOfferingId' IS DISTINCT FROM intent_row.service_offering_id::text
        OR allocation_row.input_data ->> 'serviceOfferingVersionId' IS DISTINCT FROM intent_row.service_offering_version_id::text
        OR allocation_row.input_data ->> 'serviceOfferingPriceId' IS DISTINCT FROM intent_row.service_offering_price_id::text
        OR allocation_row.input_data ->> 'patientAccountId' IS DISTINCT FROM intent_row.patient_account_id::text
        OR allocation_row.input_data ->> 'bookingActorAccountId' IS DISTINCT FROM intent_row.booking_actor_account_id::text
        OR allocation_row.input_data ->> 'currency' IS DISTINCT FROM intent_row.currency
        OR allocation_row.input_data ->> 'grossAmountMinor' IS DISTINCT FROM intent_row.price_amount_minor::text
      THEN
        RAISE EXCEPTION 'appointment financial handoff context is inconsistent';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_financial_handoff_integrity
      BEFORE INSERT OR UPDATE OR DELETE ON appointment_financial_handoffs
      FOR EACH ROW EXECUTE FUNCTION appointment_financial_handoff_guard();

    CREATE FUNCTION appointment_intent_payment_pending_guard() RETURNS trigger AS $$
    DECLARE handoff_count integer;
    BEGIN
      IF NEW.state = 'PAYMENT_PENDING' THEN
        SELECT count(*) INTO handoff_count
        FROM appointment_financial_handoffs handoff
        JOIN slot_reservations reservation ON reservation.id = handoff.slot_reservation_id
        JOIN financial_allocation_snapshots allocation ON allocation.id = handoff.financial_allocation_snapshot_id
        JOIN payment_intents payment ON payment.id = handoff.payment_intent_id
        WHERE handoff.appointment_intent_id = NEW.id
          AND handoff.booking_actor_account_id = NEW.booking_actor_account_id
          AND reservation.appointment_intent_id = NEW.id
          AND reservation.status = 'HELD'
          AND reservation.expires_at > clock_timestamp()
          AND allocation.status = 'FINAL'
          AND allocation.currency = NEW.currency
          AND allocation.gross_amount_minor = NEW.price_amount_minor
          AND payment.status = 'CREATED'
          AND payment.allocation_snapshot_id = allocation.id
          AND payment.currency = allocation.currency
          AND payment.amount_minor = allocation.gross_amount_minor;
        IF handoff_count <> 1 THEN
          RAISE EXCEPTION 'payment pending requires one consistent financial handoff';
        END IF;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_intent_payment_pending_integrity
      AFTER INSERT OR UPDATE OF state ON appointment_intents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_intent_payment_pending_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointment_financial_handoffs) THEN
        RAISE EXCEPTION 'cannot roll back payment handoff while handoffs exist';
      END IF;
    END $$;
    DROP TRIGGER appointment_intent_payment_pending_integrity ON appointment_intents;
    DROP FUNCTION appointment_intent_payment_pending_guard();
    DROP TRIGGER appointment_financial_handoff_integrity ON appointment_financial_handoffs;
    DROP FUNCTION appointment_financial_handoff_guard();
    DROP TABLE appointment_financial_handoffs;
    DROP TRIGGER appointment_intent_state_integrity ON appointment_intents;
    DROP FUNCTION appointment_intent_state_guard();
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_state_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_state_check
      CHECK (state IN ('APPOINTMENT_INTENT','SLOT_RESERVED','EXPIRED','CANCELLED'));
    DROP TRIGGER financial_allocation_components_immutable ON financial_allocation_components;
    DROP FUNCTION financial_allocation_component_immutable_guard();
  `);
};

/* theCliniQ Phase 5 Step 5.2: Appointment event and state-transition foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
      CHECK (status IN ('PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_previous_status_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_previous_status_check
      CHECK (previous_status IS NULL OR previous_status IN ('PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_resulting_status_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_resulting_status_check
      CHECK (resulting_status IS NULL OR resulting_status IN ('PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));
    CREATE UNIQUE INDEX appointment_events_transition_once
      ON appointment_events(appointment_id,previous_status,resulting_status)
      WHERE previous_status IS NOT NULL AND resulting_status IS NOT NULL;

    CREATE OR REPLACE FUNCTION appointment_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.status <> NEW.status AND NOT (
        (OLD.status='PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','PAYMENT_FAILED','EXPIRED')) OR
        (OLD.status='CONFIRMED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
        (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
      ) THEN
        RAISE EXCEPTION 'appointment state transition is invalid';
      END IF;
      NEW.updated_at = current_timestamp;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION appointment_event_guard() RETURNS trigger AS $$
    DECLARE appointment_status text;
    BEGIN
      SELECT status INTO appointment_status FROM appointments WHERE id=NEW.appointment_id;
      IF appointment_status IS NULL THEN RAISE EXCEPTION 'appointment event requires appointment'; END IF;
      IF (NEW.event_type='CONFIRMED' AND NOT (NEW.previous_status='PAYMENT_PENDING' AND NEW.resulting_status='CONFIRMED'))
        OR (NEW.event_type='PAYMENT_FAILED' AND NOT (NEW.previous_status='PAYMENT_PENDING' AND NEW.resulting_status='PAYMENT_FAILED'))
        OR (NEW.event_type='EXPIRED' AND NOT (NEW.previous_status='PAYMENT_PENDING' AND NEW.resulting_status='EXPIRED'))
        OR (NEW.event_type='STARTED' AND NOT (NEW.previous_status='CONFIRMED' AND NEW.resulting_status='IN_PROGRESS'))
        OR (NEW.event_type='COMPLETED' AND NOT (NEW.previous_status='IN_PROGRESS' AND NEW.resulting_status='COMPLETED'))
        OR (NEW.event_type='CANCELLED' AND NOT (NEW.previous_status IN ('CONFIRMED','IN_PROGRESS') AND NEW.resulting_status='CANCELLED'))
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

    CREATE OR REPLACE FUNCTION appointment_transition_event_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (
        SELECT 1
        FROM appointment_events event
        WHERE event.appointment_id = NEW.id
          AND event.previous_status = OLD.status
          AND event.resulting_status = NEW.status
      ) THEN
        RAISE EXCEPTION 'appointment state transition requires matching immutable event';
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_transition_event_integrity
      AFTER UPDATE OF status ON appointments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_transition_event_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointments WHERE status='PAYMENT_PENDING')
        OR EXISTS (SELECT 1 FROM appointment_events WHERE previous_status='PAYMENT_PENDING' OR resulting_status='PAYMENT_PENDING') THEN
        RAISE EXCEPTION 'cannot roll back appointment state transitions while payment-pending appointment history exists';
      END IF;
    END $$;
    DROP TRIGGER appointment_transition_event_integrity ON appointments;
    DROP FUNCTION appointment_transition_event_guard();
    DROP INDEX appointment_events_transition_once;
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_resulting_status_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_resulting_status_check
      CHECK (resulting_status IS NULL OR resulting_status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_previous_status_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_previous_status_check
      CHECK (previous_status IS NULL OR previous_status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));
    ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
    ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
      CHECK (status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'));

    CREATE OR REPLACE FUNCTION appointment_state_guard() RETURNS trigger AS $$
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
    CREATE OR REPLACE FUNCTION appointment_event_guard() RETURNS trigger AS $$
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
  `);
};

/* theCliniQ Phase 5 Step 3.1: Appointment Intent and Slot Reservation database foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE service_offering_version_reservation_policies (
      id uuid PRIMARY KEY,
      service_offering_version_id uuid NOT NULL UNIQUE REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      hold_seconds integer NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (hold_seconds > 0)
    );
    CREATE TABLE appointment_intents (
      id uuid PRIMARY KEY,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      provider_doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      provider_clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      service_offering_price_id uuid NOT NULL REFERENCES service_offering_prices(id) ON DELETE RESTRICT,
      currency char(3) NOT NULL, price_amount_minor bigint NOT NULL,
      provider_timezone text NOT NULL, requested_local_at timestamp NOT NULL,
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
      service_duration_seconds integer NOT NULL, buffer_before_seconds integer NOT NULL, buffer_after_seconds integer NOT NULL,
      hold_seconds integer NOT NULL, booking_relationship text NOT NULL, capability_key text,
      state text NOT NULL, idempotency_key text NOT NULL, request_fingerprint text NOT NULL,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      cancelled_at timestamptz, expired_at timestamptz,
      CHECK ((provider_doctor_profile_id IS NOT NULL AND provider_clinic_id IS NULL) OR (provider_doctor_profile_id IS NULL AND provider_clinic_id IS NOT NULL)),
      CHECK (currency ~ '^[A-Z]{3}$'), CHECK (price_amount_minor >= 0), CHECK (char_length(btrim(provider_timezone)) > 0),
      CHECK (ends_at > starts_at), CHECK (service_duration_seconds > 0), CHECK (buffer_before_seconds >= 0), CHECK (buffer_after_seconds >= 0), CHECK (hold_seconds > 0),
      CHECK (state IN ('APPOINTMENT_INTENT','SLOT_RESERVED','EXPIRED','CANCELLED')),
      CHECK (expires_at > created_at), CHECK (booking_relationship IN ('PATIENT_PROVIDER','CLINIC_DOCTOR')),
      CHECK ((booking_relationship = 'CLINIC_DOCTOR') = (capability_key = 'BOOK')),
      UNIQUE (booking_actor_account_id, idempotency_key)
    );
    CREATE INDEX appointment_intents_patient ON appointment_intents(patient_account_id, created_at);
    CREATE INDEX appointment_intents_provider ON appointment_intents(provider_doctor_profile_id, provider_clinic_id, state);
    CREATE INDEX appointment_intents_version ON appointment_intents(service_offering_version_id, starts_at);
    CREATE TABLE slot_reservations (
      id uuid PRIMARY KEY,
      appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      provider_doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      provider_clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, capacity_units integer NOT NULL,
      status text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      released_at timestamptz, expired_at timestamptz,
      CHECK ((provider_doctor_profile_id IS NOT NULL AND provider_clinic_id IS NULL) OR (provider_doctor_profile_id IS NULL AND provider_clinic_id IS NOT NULL)),
      CHECK (ends_at > starts_at), CHECK (capacity_units > 0), CHECK (status IN ('HELD','RELEASED','EXPIRED')),
      CHECK (expires_at > created_at), CHECK ((status = 'HELD' AND released_at IS NULL AND expired_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL) OR (status = 'EXPIRED' AND expired_at IS NOT NULL))
    );
    CREATE INDEX slot_reservations_capacity_lookup ON slot_reservations(service_offering_version_id, starts_at, ends_at) WHERE status = 'HELD';
    CREATE FUNCTION appointment_intent_context_guard() RETURNS trigger AS $$
    DECLARE offering_doctor uuid; offering_clinic uuid; version_offering uuid; price_version uuid; policy_hold integer;
    BEGIN
      SELECT owner_doctor_profile_id, owner_clinic_id INTO offering_doctor, offering_clinic FROM service_offerings WHERE id=NEW.service_offering_id;
      SELECT service_offering_id INTO version_offering FROM service_offering_versions WHERE id=NEW.service_offering_version_id;
      SELECT service_offering_version_id INTO price_version FROM service_offering_prices WHERE id=NEW.service_offering_price_id;
      SELECT hold_seconds INTO policy_hold FROM service_offering_version_reservation_policies WHERE service_offering_version_id=NEW.service_offering_version_id;
      IF version_offering IS DISTINCT FROM NEW.service_offering_id OR price_version IS DISTINCT FROM NEW.service_offering_version_id OR (offering_doctor IS DISTINCT FROM NEW.provider_doctor_profile_id) OR (offering_clinic IS DISTINCT FROM NEW.provider_clinic_id) OR policy_hold IS DISTINCT FROM NEW.hold_seconds THEN RAISE EXCEPTION 'appointment intent context is inconsistent'; END IF;
      IF TG_OP = 'UPDATE' AND (OLD.patient_account_id,OLD.booking_actor_account_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.service_offering_id,OLD.service_offering_version_id,OLD.service_offering_price_id,OLD.currency,OLD.price_amount_minor,OLD.provider_timezone,OLD.requested_local_at,OLD.starts_at,OLD.ends_at,OLD.service_duration_seconds,OLD.buffer_before_seconds,OLD.buffer_after_seconds,OLD.hold_seconds,OLD.idempotency_key,OLD.request_fingerprint,OLD.expires_at) IS DISTINCT FROM (NEW.patient_account_id,NEW.booking_actor_account_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds,NEW.idempotency_key,NEW.request_fingerprint,NEW.expires_at) THEN RAISE EXCEPTION 'appointment intent booking context is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_intent_context BEFORE INSERT OR UPDATE ON appointment_intents FOR EACH ROW EXECUTE FUNCTION appointment_intent_context_guard();
    CREATE FUNCTION slot_reservation_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.appointment_intent_id,OLD.service_offering_version_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.starts_at,OLD.ends_at,OLD.capacity_units,OLD.expires_at) IS DISTINCT FROM (NEW.appointment_intent_id,NEW.service_offering_version_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.starts_at,NEW.ends_at,NEW.capacity_units,NEW.expires_at) THEN RAISE EXCEPTION 'slot reservation capacity context is immutable'; END IF;
      IF TG_OP='UPDATE' AND OLD.status IN ('RELEASED','EXPIRED') AND NEW.status='HELD' THEN RAISE EXCEPTION 'expired or released reservation cannot be reactivated'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER slot_reservation_integrity BEFORE UPDATE ON slot_reservations FOR EACH ROW EXECUTE FUNCTION slot_reservation_guard();
  `);
};
exports.down = (pgm) => pgm.sql(`
  DROP TRIGGER slot_reservation_integrity ON slot_reservations;
  DROP FUNCTION slot_reservation_guard();
  DROP TRIGGER appointment_intent_context ON appointment_intents;
  DROP FUNCTION appointment_intent_context_guard();
  DROP TABLE slot_reservations;
  DROP TABLE appointment_intents;
  DROP TABLE service_offering_version_reservation_policies;
`);

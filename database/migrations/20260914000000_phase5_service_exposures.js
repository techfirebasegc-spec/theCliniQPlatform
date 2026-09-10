/* theCliniQ Phase 5: explicit patient-facing Service Exposure foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE service_exposures (
      id uuid PRIMARY KEY,
      service_offering_id uuid NOT NULL UNIQUE REFERENCES service_offerings(id) ON DELETE RESTRICT,
      provider_doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      provider_clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      updated_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      published_at timestamptz,
      unpublished_at timestamptz,
      CHECK ((provider_doctor_profile_id IS NOT NULL AND provider_clinic_id IS NULL AND tenant_id IS NULL) OR (provider_doctor_profile_id IS NULL AND provider_clinic_id IS NOT NULL AND tenant_id IS NOT NULL)),
      CHECK (status IN ('DRAFT','PUBLISHED','UNPUBLISHED'))
    );
    CREATE INDEX service_exposures_published_provider ON service_exposures(status, provider_doctor_profile_id, provider_clinic_id);

    CREATE FUNCTION service_exposure_guard() RETURNS trigger AS $$
    DECLARE offering_doctor uuid; offering_clinic uuid; clinic_tenant uuid;
    BEGIN
      SELECT owner_doctor_profile_id, owner_clinic_id INTO offering_doctor, offering_clinic FROM service_offerings WHERE id=NEW.service_offering_id;
      IF offering_doctor IS DISTINCT FROM NEW.provider_doctor_profile_id OR offering_clinic IS DISTINCT FROM NEW.provider_clinic_id THEN RAISE EXCEPTION 'service exposure provider must match service offering owner'; END IF;
      IF NEW.provider_clinic_id IS NOT NULL THEN
        SELECT tenant_id INTO clinic_tenant FROM clinics WHERE id=NEW.provider_clinic_id;
        IF clinic_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'service exposure tenant must match clinic tenant'; END IF;
      END IF;
      IF TG_OP='INSERT' AND NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'service exposure must be created as draft'; END IF;
      IF TG_OP='UPDATE' THEN
        IF (OLD.service_offering_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.tenant_id,OLD.created_by_account_id) IS DISTINCT FROM (NEW.service_offering_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.tenant_id,NEW.created_by_account_id) THEN RAISE EXCEPTION 'service exposure ownership context is immutable'; END IF;
        IF OLD.status <> NEW.status THEN
          IF NOT ((OLD.status='DRAFT' AND NEW.status='PUBLISHED') OR (OLD.status='PUBLISHED' AND NEW.status='UNPUBLISHED') OR (OLD.status='UNPUBLISHED' AND NEW.status='PUBLISHED')) THEN RAISE EXCEPTION 'service exposure lifecycle transition is invalid'; END IF;
          IF NEW.status='PUBLISHED' THEN NEW.published_at=current_timestamp; END IF;
          IF NEW.status='UNPUBLISHED' THEN NEW.unpublished_at=current_timestamp; END IF;
        END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER service_exposure_integrity BEFORE INSERT OR UPDATE ON service_exposures FOR EACH ROW EXECUTE FUNCTION service_exposure_guard();

    ALTER TABLE appointment_intents ADD COLUMN service_exposure_id uuid REFERENCES service_exposures(id) ON DELETE RESTRICT;
    CREATE INDEX appointment_intents_exposure ON appointment_intents(service_exposure_id);
    CREATE OR REPLACE FUNCTION appointment_intent_context_guard() RETURNS trigger AS $$
    DECLARE offering_doctor uuid; offering_clinic uuid; version_offering uuid; price_version uuid; policy_hold integer; exposure_offering uuid; exposure_doctor uuid; exposure_clinic uuid;
    BEGIN
      SELECT owner_doctor_profile_id, owner_clinic_id INTO offering_doctor, offering_clinic FROM service_offerings WHERE id=NEW.service_offering_id;
      SELECT service_offering_id INTO version_offering FROM service_offering_versions WHERE id=NEW.service_offering_version_id;
      SELECT service_offering_version_id INTO price_version FROM service_offering_prices WHERE id=NEW.service_offering_price_id;
      SELECT hold_seconds INTO policy_hold FROM service_offering_version_reservation_policies WHERE service_offering_version_id=NEW.service_offering_version_id;
      IF TG_OP='INSERT' AND NEW.service_exposure_id IS NULL THEN RAISE EXCEPTION 'appointment intent exposure context is inconsistent'; END IF;
      IF NEW.service_exposure_id IS NOT NULL THEN
        SELECT service_offering_id, provider_doctor_profile_id, provider_clinic_id INTO exposure_offering, exposure_doctor, exposure_clinic FROM service_exposures WHERE id=NEW.service_exposure_id;
        IF exposure_offering IS DISTINCT FROM NEW.service_offering_id OR exposure_doctor IS DISTINCT FROM NEW.provider_doctor_profile_id OR exposure_clinic IS DISTINCT FROM NEW.provider_clinic_id THEN RAISE EXCEPTION 'appointment intent exposure context is inconsistent'; END IF;
      END IF;
      IF version_offering IS DISTINCT FROM NEW.service_offering_id OR price_version IS DISTINCT FROM NEW.service_offering_version_id OR offering_doctor IS DISTINCT FROM NEW.provider_doctor_profile_id OR offering_clinic IS DISTINCT FROM NEW.provider_clinic_id OR policy_hold IS DISTINCT FROM NEW.hold_seconds THEN RAISE EXCEPTION 'appointment intent context is inconsistent'; END IF;
      IF TG_OP = 'UPDATE' AND (OLD.patient_account_id,OLD.booking_actor_account_id,OLD.booking_tenant_id,OLD.service_exposure_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.service_offering_id,OLD.service_offering_version_id,OLD.service_offering_price_id,OLD.currency,OLD.price_amount_minor,OLD.provider_timezone,OLD.requested_local_at,OLD.starts_at,OLD.ends_at,OLD.service_duration_seconds,OLD.buffer_before_seconds,OLD.buffer_after_seconds,OLD.hold_seconds,OLD.idempotency_key,OLD.request_fingerprint,OLD.expires_at) IS DISTINCT FROM (NEW.patient_account_id,NEW.booking_actor_account_id,NEW.booking_tenant_id,NEW.service_exposure_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds,NEW.idempotency_key,NEW.request_fingerprint,NEW.expires_at) THEN RAISE EXCEPTION 'appointment intent booking context is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointment_intents WHERE service_exposure_id IS NOT NULL) THEN RAISE EXCEPTION 'cannot roll back service exposures while appointment intents reference exposures'; END IF;
    END $$;
    ALTER TABLE appointment_intents DROP COLUMN service_exposure_id;
    CREATE OR REPLACE FUNCTION appointment_intent_context_guard() RETURNS trigger AS $$
    DECLARE offering_doctor uuid; offering_clinic uuid; version_offering uuid; price_version uuid; policy_hold integer;
    BEGIN
      SELECT owner_doctor_profile_id, owner_clinic_id INTO offering_doctor, offering_clinic FROM service_offerings WHERE id=NEW.service_offering_id;
      SELECT service_offering_id INTO version_offering FROM service_offering_versions WHERE id=NEW.service_offering_version_id;
      SELECT service_offering_version_id INTO price_version FROM service_offering_prices WHERE id=NEW.service_offering_price_id;
      SELECT hold_seconds INTO policy_hold FROM service_offering_version_reservation_policies WHERE service_offering_version_id=NEW.service_offering_version_id;
      IF version_offering IS DISTINCT FROM NEW.service_offering_id OR price_version IS DISTINCT FROM NEW.service_offering_version_id OR offering_doctor IS DISTINCT FROM NEW.provider_doctor_profile_id OR offering_clinic IS DISTINCT FROM NEW.provider_clinic_id OR policy_hold IS DISTINCT FROM NEW.hold_seconds THEN RAISE EXCEPTION 'appointment intent context is inconsistent'; END IF;
      IF TG_OP = 'UPDATE' AND (OLD.patient_account_id,OLD.booking_actor_account_id,OLD.provider_doctor_profile_id,OLD.provider_clinic_id,OLD.service_offering_id,OLD.service_offering_version_id,OLD.service_offering_price_id,OLD.currency,OLD.price_amount_minor,OLD.provider_timezone,OLD.requested_local_at,OLD.starts_at,OLD.ends_at,OLD.service_duration_seconds,OLD.buffer_before_seconds,OLD.buffer_after_seconds,OLD.hold_seconds,OLD.idempotency_key,OLD.request_fingerprint,OLD.expires_at) IS DISTINCT FROM (NEW.patient_account_id,NEW.booking_actor_account_id,NEW.provider_doctor_profile_id,NEW.provider_clinic_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.currency,NEW.price_amount_minor,NEW.provider_timezone,NEW.requested_local_at,NEW.starts_at,NEW.ends_at,NEW.service_duration_seconds,NEW.buffer_before_seconds,NEW.buffer_after_seconds,NEW.hold_seconds,NEW.idempotency_key,NEW.request_fingerprint,NEW.expires_at) THEN RAISE EXCEPTION 'appointment intent booking context is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    DROP TRIGGER service_exposure_integrity ON service_exposures;
    DROP FUNCTION service_exposure_guard();
    DROP TABLE service_exposures;
  `);
};

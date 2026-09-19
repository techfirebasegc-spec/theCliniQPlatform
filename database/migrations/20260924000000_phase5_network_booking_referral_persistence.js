/* theCliniQ Phase 5.8 Step 1: network booking, referral, and queue persistence foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE retention_policy_versions DROP CONSTRAINT retention_policy_versions_record_category_check;
    ALTER TABLE retention_policy_versions ADD CONSTRAINT retention_policy_versions_record_category_check
      CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK','REFERRAL'));
    ALTER TABLE legal_holds DROP CONSTRAINT legal_holds_record_category_check;
    ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_record_category_check
      CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK','REFERRAL'));

    CREATE TABLE patient_delegated_booking_authorization_policy_versions (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      version_number integer NOT NULL UNIQUE,
      effective_from timestamptz NOT NULL,
      effective_until timestamptz,
      expiry_seconds integer NOT NULL,
      approved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
      CHECK (effective_until IS NULL OR effective_until > effective_from),
      CHECK (expiry_seconds > 0)
    );
    CREATE TABLE appointment_referral_policy_versions (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      version_number integer NOT NULL UNIQUE,
      effective_from timestamptz NOT NULL,
      effective_until timestamptz,
      expiry_seconds integer NOT NULL,
      approved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
      CHECK (effective_until IS NULL OR effective_until > effective_from),
      CHECK (expiry_seconds > 0)
    );

    CREATE TABLE service_offering_version_queue_policies (
      id uuid PRIMARY KEY,
      service_offering_version_id uuid NOT NULL UNIQUE REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      maximum_capacity integer NOT NULL,
      booking_cutoff_seconds integer NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (maximum_capacity > 0),
      CHECK (booking_cutoff_seconds >= 0)
    );

    CREATE TABLE queue_windows (
      id uuid PRIMARY KEY,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      availability_configuration_id uuid NOT NULL REFERENCES availability_configurations(id) ON DELETE RESTRICT,
      queue_policy_id uuid NOT NULL REFERENCES service_offering_version_queue_policies(id) ON DELETE RESTRICT,
      local_start timestamp NOT NULL,
      local_end timestamp NOT NULL,
      derived_start_utc timestamptz NOT NULL,
      derived_end_utc timestamptz NOT NULL,
      maximum_capacity integer NOT NULL,
      booking_cutoff_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'OPEN',
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (local_end > local_start),
      CHECK (derived_end_utc > derived_start_utc),
      CHECK (maximum_capacity > 0),
      CHECK (booking_cutoff_at <= derived_start_utc),
      CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
      UNIQUE (availability_configuration_id, local_start, local_end)
    );
    CREATE INDEX queue_windows_version_range ON queue_windows(service_offering_version_id, derived_start_utc, derived_end_utc);
    CREATE INDEX queue_windows_configuration_range ON queue_windows(availability_configuration_id, derived_start_utc, derived_end_utc);

    CREATE TABLE patient_clinic_booking_authorizations (
      id uuid PRIMARY KEY,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      delegated_clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      delegated_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      target_doctor_profile_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      service_exposure_id uuid NOT NULL REFERENCES service_exposures(id) ON DELETE RESTRICT,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      scheduling_mode text NOT NULL,
      approved_starts_at timestamptz,
      approved_ends_at timestamptz,
      queue_window_id uuid REFERENCES queue_windows(id) ON DELETE RESTRICT,
      scope_fingerprint text NOT NULL,
      policy_version_id uuid NOT NULL REFERENCES patient_delegated_booking_authorization_policy_versions(id) ON DELETE RESTRICT,
      consented_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      consented_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      status text NOT NULL,
      consuming_appointment_intent_id uuid UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      consumed_at timestamptz,
      consumed_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      revoked_at timestamptz,
      revoked_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      revocation_reason_category text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (scheduling_mode IN ('FIXED_SLOT','QUEUE')),
      CHECK (char_length(btrim(scope_fingerprint)) > 0),
      CHECK (expires_at > created_at),
      CHECK ((scheduling_mode='FIXED_SLOT' AND approved_starts_at IS NOT NULL AND approved_ends_at IS NOT NULL AND approved_ends_at > approved_starts_at AND queue_window_id IS NULL) OR (scheduling_mode='QUEUE' AND approved_starts_at IS NULL AND approved_ends_at IS NULL AND queue_window_id IS NOT NULL)),
      CHECK ((status='ACTIVE' AND consuming_appointment_intent_id IS NULL AND consumed_at IS NULL AND consumed_by_account_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revocation_reason_category IS NULL) OR (status='CONSUMED' AND consuming_appointment_intent_id IS NOT NULL AND consumed_at IS NOT NULL AND consumed_by_account_id IS NOT NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revocation_reason_category IS NULL) OR (status='REVOKED' AND consuming_appointment_intent_id IS NULL AND consumed_at IS NULL AND consumed_by_account_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL AND revocation_reason_category IS NOT NULL) OR (status='EXPIRED' AND consuming_appointment_intent_id IS NULL AND consumed_at IS NULL AND consumed_by_account_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revocation_reason_category IS NULL))
    );
    CREATE INDEX patient_clinic_booking_authorizations_lookup ON patient_clinic_booking_authorizations(delegated_clinic_id, patient_account_id, service_exposure_id, status, expires_at);
    CREATE INDEX patient_clinic_booking_authorizations_active_scope ON patient_clinic_booking_authorizations(scope_fingerprint) WHERE status='ACTIVE';

    CREATE TABLE appointment_referrals (
      id uuid PRIMARY KEY,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      referring_clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      referring_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      receiving_clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      receiving_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      network_connection_id uuid NOT NULL REFERENCES network_connections(id) ON DELETE RESTRICT,
      network_capability_id uuid NOT NULL REFERENCES network_connection_capabilities(id) ON DELETE RESTRICT,
      accepted_proposal_id uuid NOT NULL REFERENCES network_capability_proposals(id) ON DELETE RESTRICT,
      destination_service_exposure_id uuid NOT NULL REFERENCES service_exposures(id) ON DELETE RESTRICT,
      destination_service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      purpose_context_fingerprint text NOT NULL,
      policy_version_id uuid NOT NULL REFERENCES appointment_referral_policy_versions(id) ON DELETE RESTRICT,
      retention_policy_version_id uuid NOT NULL REFERENCES retention_policy_versions(id) ON DELETE RESTRICT,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      expires_at timestamptz NOT NULL,
      status text NOT NULL,
      accepted_at timestamptz,
      accepted_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      rejected_at timestamptz,
      rejected_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      withdrawn_at timestamptz,
      withdrawn_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      withdrawal_reason_category text,
      consumed_at timestamptz,
      consuming_appointment_intent_id uuid UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (referring_clinic_id <> receiving_clinic_id),
      CHECK (char_length(btrim(purpose_context_fingerprint)) > 0),
      CHECK (expires_at > created_at),
      CHECK (status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC','ACCEPTED','CONSUMED','REJECTED','WITHDRAWN','EXPIRED')),
      CHECK (
        (status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC')
          AND accepted_at IS NULL AND accepted_by_account_id IS NULL
          AND rejected_at IS NULL AND rejected_by_account_id IS NULL
          AND withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND withdrawal_reason_category IS NULL
          AND consumed_at IS NULL AND consuming_appointment_intent_id IS NULL)
        OR (status='ACCEPTED'
          AND accepted_at IS NOT NULL AND accepted_by_account_id IS NOT NULL
          AND rejected_at IS NULL AND rejected_by_account_id IS NULL
          AND withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND withdrawal_reason_category IS NULL
          AND consumed_at IS NULL AND consuming_appointment_intent_id IS NULL)
        OR (status='CONSUMED'
          AND accepted_at IS NOT NULL AND accepted_by_account_id IS NOT NULL
          AND rejected_at IS NULL AND rejected_by_account_id IS NULL
          AND withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND withdrawal_reason_category IS NULL
          AND consumed_at IS NOT NULL AND consuming_appointment_intent_id IS NOT NULL)
        OR (status='REJECTED'
          AND accepted_at IS NULL AND accepted_by_account_id IS NULL
          AND rejected_at IS NOT NULL AND rejected_by_account_id IS NOT NULL
          AND withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND withdrawal_reason_category IS NULL
          AND consumed_at IS NULL AND consuming_appointment_intent_id IS NULL)
        OR (status='WITHDRAWN'
          AND accepted_at IS NULL AND accepted_by_account_id IS NULL
          AND rejected_at IS NULL AND rejected_by_account_id IS NULL
          AND withdrawn_at IS NOT NULL AND withdrawn_by_account_id IS NOT NULL AND withdrawal_reason_category IS NOT NULL
          AND consumed_at IS NULL AND consuming_appointment_intent_id IS NULL)
        OR (status='EXPIRED'
          AND accepted_at IS NULL AND accepted_by_account_id IS NULL
          AND rejected_at IS NULL AND rejected_by_account_id IS NULL
          AND withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND withdrawal_reason_category IS NULL
          AND consumed_at IS NULL AND consuming_appointment_intent_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX appointment_referrals_pending_unique ON appointment_referrals(patient_account_id, referring_clinic_id, receiving_clinic_id, purpose_context_fingerprint) WHERE status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC');
    CREATE INDEX appointment_referrals_receiving_lookup ON appointment_referrals(receiving_clinic_id,status,expires_at);
    CREATE INDEX appointment_referrals_referring_lookup ON appointment_referrals(referring_clinic_id,status,expires_at);
    CREATE INDEX appointment_referrals_patient_lookup ON appointment_referrals(patient_account_id,status,expires_at);

    CREATE TABLE referral_consent_events (
      id uuid PRIMARY KEY,
      appointment_referral_id uuid NOT NULL REFERENCES appointment_referrals(id) ON DELETE RESTRICT,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      event_type text NOT NULL,
      actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      scope_fingerprint text NOT NULL,
      reason_category text,
      occurred_at timestamptz NOT NULL DEFAULT current_timestamp,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (event_type IN ('GRANTED','DECLINED','WITHDRAWN')),
      CHECK (char_length(btrim(scope_fingerprint)) > 0)
    );
    CREATE INDEX referral_consent_events_referral ON referral_consent_events(appointment_referral_id, occurred_at, id);

    ALTER TABLE appointment_intents ADD COLUMN scheduling_mode text NOT NULL DEFAULT 'FIXED_SLOT';
    ALTER TABLE appointment_intents ADD COLUMN queue_window_id uuid REFERENCES queue_windows(id) ON DELETE RESTRICT;
    ALTER TABLE appointment_intents ADD COLUMN queue_entry_id uuid;
    ALTER TABLE appointment_intents ADD COLUMN network_booking_context_id uuid;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_booking_relationship_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_booking_relationship_check CHECK (booking_relationship IN ('PATIENT_PROVIDER','CLINIC_DOCTOR','CLINIC_CLINIC'));
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_check CHECK ((booking_relationship='PATIENT_PROVIDER' AND capability_key IS NULL) OR (booking_relationship='CLINIC_DOCTOR' AND capability_key='BOOK') OR (booking_relationship='CLINIC_CLINIC' AND capability_key='REFER'));
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_scheduling_mode_check CHECK (scheduling_mode IN ('FIXED_SLOT','QUEUE'));
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_queue_context_check CHECK ((scheduling_mode='FIXED_SLOT' AND queue_window_id IS NULL AND queue_entry_id IS NULL) OR (scheduling_mode='QUEUE' AND queue_window_id IS NOT NULL));

    CREATE TABLE network_booking_contexts (
      id uuid PRIMARY KEY,
      appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      booking_kind text NOT NULL,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      originating_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      network_connection_id uuid NOT NULL REFERENCES network_connections(id) ON DELETE RESTRICT,
      network_capability_id uuid NOT NULL REFERENCES network_connection_capabilities(id) ON DELETE RESTRICT,
      accepted_proposal_id uuid NOT NULL REFERENCES network_capability_proposals(id) ON DELETE RESTRICT,
      patient_clinic_booking_authorization_id uuid UNIQUE REFERENCES patient_clinic_booking_authorizations(id) ON DELETE RESTRICT,
      appointment_referral_id uuid UNIQUE REFERENCES appointment_referrals(id) ON DELETE RESTRICT,
      service_exposure_id uuid NOT NULL REFERENCES service_exposures(id) ON DELETE RESTRICT,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      service_offering_version_id uuid NOT NULL REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      service_offering_price_id uuid NOT NULL REFERENCES service_offering_prices(id) ON DELETE RESTRICT,
      scheduling_mode text NOT NULL,
      queue_window_id uuid REFERENCES queue_windows(id) ON DELETE RESTRICT,
      queue_entry_id uuid,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (booking_kind IN ('CLINIC_DOCTOR_DELEGATED','CLINIC_CLINIC_REFERRAL')),
      CHECK ((booking_kind='CLINIC_DOCTOR_DELEGATED' AND patient_clinic_booking_authorization_id IS NOT NULL AND appointment_referral_id IS NULL) OR (booking_kind='CLINIC_CLINIC_REFERRAL' AND patient_clinic_booking_authorization_id IS NULL AND appointment_referral_id IS NOT NULL)),
      CHECK (scheduling_mode IN ('FIXED_SLOT','QUEUE')),
      CHECK ((scheduling_mode='FIXED_SLOT' AND queue_window_id IS NULL AND queue_entry_id IS NULL) OR (scheduling_mode='QUEUE' AND queue_window_id IS NOT NULL))
    );
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_network_booking_context_fk FOREIGN KEY (network_booking_context_id) REFERENCES network_booking_contexts(id) ON DELETE RESTRICT;
    CREATE INDEX network_booking_contexts_connection_capability ON network_booking_contexts(network_connection_id,network_capability_id);

    CREATE TABLE queue_entries (
      id uuid PRIMARY KEY,
      queue_window_id uuid NOT NULL REFERENCES queue_windows(id) ON DELETE RESTRICT,
      appointment_intent_id uuid NOT NULL UNIQUE REFERENCES appointment_intents(id) ON DELETE RESTRICT,
      patient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      booking_actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      maximum_capacity integer NOT NULL,
      queue_position integer NOT NULL,
      queue_status text NOT NULL DEFAULT 'WAITING',
      capacity_status text NOT NULL DEFAULT 'ACTIVE',
      released_at timestamptz,
      release_reason_category text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (maximum_capacity > 0),
      CHECK (queue_position > 0),
      CHECK (queue_status IN ('WAITING','CALLED','COMPLETED','CANCELLED','NO_SHOW')),
      CHECK (capacity_status IN ('ACTIVE','RELEASED')),
      CHECK ((capacity_status='ACTIVE' AND released_at IS NULL AND release_reason_category IS NULL) OR (capacity_status='RELEASED' AND released_at IS NOT NULL AND release_reason_category IS NOT NULL)),
      UNIQUE (queue_window_id, queue_position)
    );
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_queue_entry_fk FOREIGN KEY (queue_entry_id) REFERENCES queue_entries(id) ON DELETE RESTRICT;
    ALTER TABLE network_booking_contexts ADD CONSTRAINT network_booking_contexts_queue_entry_fk FOREIGN KEY (queue_entry_id) REFERENCES queue_entries(id) ON DELETE RESTRICT;
    CREATE INDEX queue_entries_capacity_lookup ON queue_entries(queue_window_id, capacity_status, queue_position);

    ALTER TABLE appointments ADD COLUMN scheduling_mode text NOT NULL DEFAULT 'FIXED_SLOT';
    ALTER TABLE appointments ADD COLUMN queue_window_id uuid REFERENCES queue_windows(id) ON DELETE RESTRICT;
    ALTER TABLE appointments ADD COLUMN queue_entry_id uuid REFERENCES queue_entries(id) ON DELETE RESTRICT;
    ALTER TABLE appointments ADD COLUMN network_booking_context_id uuid REFERENCES network_booking_contexts(id) ON DELETE RESTRICT;
    ALTER TABLE appointments ADD CONSTRAINT appointments_scheduling_mode_check CHECK (scheduling_mode IN ('FIXED_SLOT','QUEUE'));
    ALTER TABLE appointments ADD CONSTRAINT appointments_queue_context_check CHECK ((scheduling_mode='FIXED_SLOT' AND queue_window_id IS NULL AND queue_entry_id IS NULL) OR (scheduling_mode='QUEUE' AND queue_window_id IS NOT NULL AND queue_entry_id IS NOT NULL));

    CREATE FUNCTION phase58_policy_version_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'network booking policy version cannot be deleted'; END IF;
      IF ROW(OLD.version_number,OLD.effective_from,OLD.effective_until,OLD.expiry_seconds,OLD.approved_by_account_id,OLD.created_at) IS DISTINCT FROM ROW(NEW.version_number,NEW.effective_from,NEW.effective_until,NEW.expiry_seconds,NEW.approved_by_account_id,NEW.created_at) THEN RAISE EXCEPTION 'network booking policy version is immutable'; END IF;
      IF OLD.status <> NEW.status AND NOT ((OLD.status='DRAFT' AND NEW.status='APPROVED') OR (OLD.status='APPROVED' AND NEW.status='RETIRED')) THEN RAISE EXCEPTION 'network booking policy version transition is invalid'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER patient_delegated_booking_authorization_policy_versions_guard BEFORE UPDATE OR DELETE ON patient_delegated_booking_authorization_policy_versions FOR EACH ROW EXECUTE FUNCTION phase58_policy_version_guard();
    CREATE TRIGGER appointment_referral_policy_versions_guard BEFORE UPDATE OR DELETE ON appointment_referral_policy_versions FOR EACH ROW EXECUTE FUNCTION phase58_policy_version_guard();

    CREATE FUNCTION queue_policy_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'queue policy cannot be changed'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER service_offering_version_queue_policies_integrity BEFORE UPDATE OR DELETE ON service_offering_version_queue_policies FOR EACH ROW EXECUTE FUNCTION queue_policy_guard();

    CREATE FUNCTION queue_window_guard() RETURNS trigger AS $$
    DECLARE timezone_name text; derived_start timestamptz; derived_end timestamptz; policy_version uuid; policy_capacity integer; policy_cutoff integer;
    BEGIN
      SELECT provider_timezone,service_offering_version_id INTO timezone_name,policy_version FROM availability_configurations WHERE id=NEW.availability_configuration_id;
      SELECT maximum_capacity,booking_cutoff_seconds INTO policy_capacity,policy_cutoff FROM service_offering_version_queue_policies WHERE id=NEW.queue_policy_id;
      derived_start := availability_derive_utc(timezone_name,NEW.local_start); derived_end := availability_derive_utc(timezone_name,NEW.local_end);
      IF timezone_name IS NULL OR policy_version IS DISTINCT FROM NEW.service_offering_version_id OR policy_capacity IS NULL OR derived_start IS NULL OR derived_end IS NULL THEN RAISE EXCEPTION 'queue window context is inconsistent'; END IF;
      IF NEW.local_start::date <> NEW.local_end::date THEN RAISE EXCEPTION 'queue window must remain within one local day'; END IF;
      NEW.derived_start_utc := derived_start; NEW.derived_end_utc := derived_end;
      IF NEW.maximum_capacity IS DISTINCT FROM policy_capacity OR NEW.booking_cutoff_at IS DISTINCT FROM (derived_start - make_interval(secs => policy_cutoff)) THEN RAISE EXCEPTION 'queue window policy snapshot is inconsistent'; END IF;
      IF TG_OP='UPDATE' AND ROW(OLD.service_offering_version_id,OLD.availability_configuration_id,OLD.queue_policy_id,OLD.local_start,OLD.local_end,OLD.derived_start_utc,OLD.derived_end_utc,OLD.maximum_capacity,OLD.booking_cutoff_at,OLD.created_by_account_id,OLD.created_at) IS DISTINCT FROM ROW(NEW.service_offering_version_id,NEW.availability_configuration_id,NEW.queue_policy_id,NEW.local_start,NEW.local_end,NEW.derived_start_utc,NEW.derived_end_utc,NEW.maximum_capacity,NEW.booking_cutoff_at,NEW.created_by_account_id,NEW.created_at) THEN RAISE EXCEPTION 'queue window context is immutable'; END IF;
      IF TG_OP='UPDATE' AND OLD.status <> NEW.status AND NOT ((OLD.status='OPEN' AND NEW.status IN ('CLOSED','CANCELLED')) OR (OLD.status='CLOSED' AND NEW.status='CANCELLED')) THEN RAISE EXCEPTION 'queue window transition is invalid'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER queue_windows_integrity BEFORE INSERT OR UPDATE ON queue_windows FOR EACH ROW EXECUTE FUNCTION queue_window_guard();

    CREATE FUNCTION patient_clinic_booking_authorization_guard() RETURNS trigger AS $$
    DECLARE patient_account uuid; clinic_tenant uuid; exposure_doctor uuid; exposure_offering uuid; policy_expiry integer; queue_offering uuid;
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'patient delegated booking authorization cannot be deleted'; END IF;
      SELECT account_id INTO patient_account FROM patient_profiles WHERE id=NEW.patient_profile_id;
      SELECT tenant_id INTO clinic_tenant FROM clinics WHERE id=NEW.delegated_clinic_id;
      SELECT provider_doctor_profile_id,service_offering_id INTO exposure_doctor,exposure_offering FROM service_exposures WHERE id=NEW.service_exposure_id;
      SELECT expiry_seconds INTO policy_expiry FROM patient_delegated_booking_authorization_policy_versions WHERE id=NEW.policy_version_id AND status='APPROVED';
      IF patient_account IS DISTINCT FROM NEW.patient_account_id OR clinic_tenant IS DISTINCT FROM NEW.delegated_tenant_id OR exposure_doctor IS DISTINCT FROM NEW.target_doctor_profile_id OR exposure_offering IS DISTINCT FROM NEW.service_offering_id OR NEW.consented_by_account_id IS DISTINCT FROM NEW.patient_account_id OR policy_expiry IS NULL OR NEW.expires_at IS DISTINCT FROM (NEW.created_at + make_interval(secs => policy_expiry)) THEN RAISE EXCEPTION 'patient delegated booking authorization context is inconsistent'; END IF;
      IF NEW.scheduling_mode='QUEUE' THEN SELECT version.service_offering_id INTO queue_offering FROM queue_windows queue_window JOIN service_offering_versions version ON version.id=queue_window.service_offering_version_id WHERE queue_window.id=NEW.queue_window_id; IF queue_offering IS DISTINCT FROM NEW.service_offering_id THEN RAISE EXCEPTION 'patient delegated booking authorization queue window is inconsistent'; END IF; END IF;
      IF TG_OP='INSERT' AND NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'patient delegated booking authorization must begin active'; END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.patient_account_id,OLD.patient_profile_id,OLD.delegated_clinic_id,OLD.delegated_tenant_id,OLD.target_doctor_profile_id,OLD.service_exposure_id,OLD.service_offering_id,OLD.scheduling_mode,OLD.approved_starts_at,OLD.approved_ends_at,OLD.queue_window_id,OLD.scope_fingerprint,OLD.policy_version_id,OLD.consented_by_account_id,OLD.consented_at,OLD.expires_at,OLD.created_at) IS DISTINCT FROM ROW(NEW.patient_account_id,NEW.patient_profile_id,NEW.delegated_clinic_id,NEW.delegated_tenant_id,NEW.target_doctor_profile_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.scheduling_mode,NEW.approved_starts_at,NEW.approved_ends_at,NEW.queue_window_id,NEW.scope_fingerprint,NEW.policy_version_id,NEW.consented_by_account_id,NEW.consented_at,NEW.expires_at,NEW.created_at) THEN RAISE EXCEPTION 'patient delegated booking authorization scope is immutable'; END IF;
        IF OLD.status <> NEW.status AND NOT ((OLD.status='ACTIVE' AND NEW.status IN ('CONSUMED','REVOKED','EXPIRED'))) THEN RAISE EXCEPTION 'patient delegated booking authorization transition is invalid'; END IF;
        IF OLD.status='ACTIVE' AND NEW.status='REVOKED' AND NEW.revoked_by_account_id IS DISTINCT FROM NEW.patient_account_id THEN RAISE EXCEPTION 'patient delegated booking authorization revocation requires patient actor'; END IF;
        IF OLD.status='ACTIVE' AND NEW.status='CONSUMED' AND NEW.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'expired patient delegated booking authorization cannot be consumed'; END IF;
        IF OLD.status IN ('CONSUMED','REVOKED','EXPIRED') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'patient delegated booking authorization cannot reactivate'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER patient_clinic_booking_authorizations_integrity BEFORE INSERT OR UPDATE OR DELETE ON patient_clinic_booking_authorizations FOR EACH ROW EXECUTE FUNCTION patient_clinic_booking_authorization_guard();

    CREATE FUNCTION appointment_referral_guard() RETURNS trigger AS $$
    DECLARE patient_account uuid; referring_tenant uuid; receiving_tenant uuid; connection network_connections%ROWTYPE; capability network_connection_capabilities%ROWTYPE; proposal network_capability_proposals%ROWTYPE; exposure_clinic uuid; exposure_offering uuid; expiry_seconds_value integer; retention_category text;
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'appointment referral cannot be deleted'; END IF;
      SELECT account_id INTO patient_account FROM patient_profiles WHERE id=NEW.patient_profile_id;
      SELECT tenant_id INTO referring_tenant FROM clinics WHERE id=NEW.referring_clinic_id;
      SELECT tenant_id INTO receiving_tenant FROM clinics WHERE id=NEW.receiving_clinic_id;
      SELECT * INTO connection FROM network_connections WHERE id=NEW.network_connection_id;
      SELECT * INTO capability FROM network_connection_capabilities WHERE id=NEW.network_capability_id;
      SELECT * INTO proposal FROM network_capability_proposals WHERE id=NEW.accepted_proposal_id;
      SELECT provider_clinic_id,service_offering_id INTO exposure_clinic,exposure_offering FROM service_exposures WHERE id=NEW.destination_service_exposure_id;
      SELECT expiry_seconds INTO expiry_seconds_value FROM appointment_referral_policy_versions WHERE id=NEW.policy_version_id AND status='APPROVED';
      SELECT record_category INTO retention_category FROM retention_policy_versions WHERE id=NEW.retention_policy_version_id AND status='APPROVED';
      IF patient_account IS DISTINCT FROM NEW.patient_account_id OR referring_tenant IS DISTINCT FROM NEW.referring_tenant_id OR receiving_tenant IS DISTINCT FROM NEW.receiving_tenant_id OR exposure_clinic IS DISTINCT FROM NEW.receiving_clinic_id OR exposure_offering IS DISTINCT FROM NEW.destination_service_offering_id OR expiry_seconds_value IS NULL OR retention_category IS DISTINCT FROM 'REFERRAL' OR NEW.expires_at IS DISTINCT FROM (NEW.created_at + make_interval(secs => expiry_seconds_value)) THEN RAISE EXCEPTION 'appointment referral context is inconsistent'; END IF;
      IF connection.id IS NULL OR connection.connection_kind <> 'CLINIC_CLINIC' OR connection.status <> 'ACCEPTED' OR NOT (NEW.referring_clinic_id IN (connection.clinic_left_id,connection.clinic_right_id) AND NEW.receiving_clinic_id IN (connection.clinic_left_id,connection.clinic_right_id)) OR capability.network_connection_id IS DISTINCT FROM NEW.network_connection_id OR capability.capability_key <> 'REFER' OR capability.status <> 'ACTIVE' OR capability.accepted_proposal_id IS DISTINCT FROM NEW.accepted_proposal_id OR capability.grantor_clinic_id IS DISTINCT FROM NEW.receiving_clinic_id OR capability.grantee_clinic_id IS DISTINCT FROM NEW.referring_clinic_id OR proposal.status <> 'ACCEPTED' THEN RAISE EXCEPTION 'appointment referral network context is inconsistent'; END IF;
      IF TG_OP='INSERT' AND NEW.status <> 'PENDING_PATIENT_CONSENT' THEN RAISE EXCEPTION 'appointment referral must begin pending patient consent'; END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.patient_account_id,OLD.patient_profile_id,OLD.referring_clinic_id,OLD.referring_tenant_id,OLD.receiving_clinic_id,OLD.receiving_tenant_id,OLD.network_connection_id,OLD.network_capability_id,OLD.accepted_proposal_id,OLD.destination_service_exposure_id,OLD.destination_service_offering_id,OLD.purpose_context_fingerprint,OLD.policy_version_id,OLD.retention_policy_version_id,OLD.created_by_account_id,OLD.expires_at,OLD.created_at) IS DISTINCT FROM ROW(NEW.patient_account_id,NEW.patient_profile_id,NEW.referring_clinic_id,NEW.referring_tenant_id,NEW.receiving_clinic_id,NEW.receiving_tenant_id,NEW.network_connection_id,NEW.network_capability_id,NEW.accepted_proposal_id,NEW.destination_service_exposure_id,NEW.destination_service_offering_id,NEW.purpose_context_fingerprint,NEW.policy_version_id,NEW.retention_policy_version_id,NEW.created_by_account_id,NEW.expires_at,NEW.created_at) THEN RAISE EXCEPTION 'appointment referral context is immutable'; END IF;
        IF OLD.status <> NEW.status AND NOT ((OLD.status='PENDING_PATIENT_CONSENT' AND NEW.status IN ('PENDING_RECEIVING_CLINIC','WITHDRAWN','EXPIRED')) OR (OLD.status='PENDING_RECEIVING_CLINIC' AND NEW.status IN ('ACCEPTED','REJECTED','WITHDRAWN','EXPIRED')) OR (OLD.status='ACCEPTED' AND NEW.status IN ('CONSUMED','EXPIRED'))) THEN RAISE EXCEPTION 'appointment referral transition is invalid'; END IF;
        IF OLD.status='PENDING_RECEIVING_CLINIC' AND NEW.status IN ('ACCEPTED','REJECTED') AND NOT EXISTS (
          SELECT 1 FROM tenant_memberships membership
          WHERE membership.tenant_id=NEW.receiving_tenant_id AND membership.account_id=CASE WHEN NEW.status='ACCEPTED' THEN NEW.accepted_by_account_id ELSE NEW.rejected_by_account_id END
            AND membership.status='ACTIVE' AND membership.role_key IN ('CLINIC_OWNER','CLINIC_ADMIN')
        ) THEN RAISE EXCEPTION 'appointment referral receiving action requires authorized clinic actor'; END IF;
        IF OLD.status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC') AND NEW.status='WITHDRAWN' AND NEW.withdrawn_by_account_id IS DISTINCT FROM NEW.patient_account_id AND NOT EXISTS (
          SELECT 1 FROM tenant_memberships membership
          WHERE membership.tenant_id=NEW.referring_tenant_id AND membership.account_id=NEW.withdrawn_by_account_id
            AND membership.status='ACTIVE' AND membership.role_key IN ('CLINIC_OWNER','CLINIC_ADMIN')
        ) THEN RAISE EXCEPTION 'appointment referral withdrawal requires authorized actor'; END IF;
        IF OLD.status IN ('CONSUMED','REJECTED','WITHDRAWN','EXPIRED') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'appointment referral cannot reactivate'; END IF;
        IF NEW.status IN ('PENDING_RECEIVING_CLINIC','ACCEPTED','CONSUMED') AND NEW.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'expired appointment referral cannot be accepted or consumed'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_referrals_integrity BEFORE INSERT OR UPDATE OR DELETE ON appointment_referrals FOR EACH ROW EXECUTE FUNCTION appointment_referral_guard();

    CREATE FUNCTION referral_consent_event_guard() RETURNS trigger AS $$
    DECLARE referral_row appointment_referrals%ROWTYPE; profile_account uuid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'referral consent evidence cannot be changed'; END IF;
      SELECT * INTO referral_row FROM appointment_referrals WHERE id=NEW.appointment_referral_id;
      SELECT account_id INTO profile_account FROM patient_profiles WHERE id=NEW.patient_profile_id;
      IF referral_row.id IS NULL OR referral_row.patient_account_id IS DISTINCT FROM NEW.patient_account_id OR referral_row.patient_profile_id IS DISTINCT FROM NEW.patient_profile_id OR profile_account IS DISTINCT FROM NEW.patient_account_id OR NEW.actor_account_id IS DISTINCT FROM NEW.patient_account_id OR referral_row.purpose_context_fingerprint IS DISTINCT FROM NEW.scope_fingerprint THEN RAISE EXCEPTION 'referral consent evidence is inconsistent'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER referral_consent_events_integrity BEFORE INSERT OR UPDATE OR DELETE ON referral_consent_events FOR EACH ROW EXECUTE FUNCTION referral_consent_event_guard();
    CREATE FUNCTION appointment_referral_consent_transition_guard() RETURNS trigger AS $$
    DECLARE final_status text;
    BEGIN
      SELECT status INTO final_status FROM appointment_referrals WHERE id=NEW.id;
      IF final_status='PENDING_RECEIVING_CLINIC' AND NOT EXISTS (
        SELECT 1 FROM referral_consent_events event
        WHERE event.appointment_referral_id=NEW.id AND event.event_type='GRANTED'
      ) THEN RAISE EXCEPTION 'appointment referral requires immutable patient consent evidence'; END IF;
      IF final_status IN ('PENDING_RECEIVING_CLINIC','ACCEPTED','CONSUMED') AND EXISTS (
        SELECT 1 FROM referral_consent_events event
        WHERE event.appointment_referral_id=NEW.id AND event.event_type='WITHDRAWN'
      ) THEN RAISE EXCEPTION 'withdrawn referral consent prevents acceptance or consumption'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_referral_consent_transition_integrity
      AFTER INSERT OR UPDATE OF status ON appointment_referrals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_referral_consent_transition_guard();
    CREATE FUNCTION referral_consent_event_state_guard() RETURNS trigger AS $$
    DECLARE referral_status text;
    BEGIN
      IF NEW.event_type='WITHDRAWN' THEN
        SELECT status INTO referral_status FROM appointment_referrals WHERE id=NEW.appointment_referral_id;
        IF referral_status IS DISTINCT FROM 'WITHDRAWN' THEN RAISE EXCEPTION 'withdrawn referral consent requires withdrawn referral lifecycle'; END IF;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER referral_consent_events_state_integrity
      AFTER INSERT ON referral_consent_events DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION referral_consent_event_state_guard();

    CREATE FUNCTION network_booking_context_guard() RETURNS trigger AS $$
    DECLARE intent_row appointment_intents%ROWTYPE; connection network_connections%ROWTYPE; capability network_connection_capabilities%ROWTYPE; proposal network_capability_proposals%ROWTYPE; delegated_authorization patient_clinic_booking_authorizations%ROWTYPE; referral appointment_referrals%ROWTYPE;
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'network booking context cannot be changed'; END IF;
      SELECT * INTO intent_row FROM appointment_intents WHERE id=NEW.appointment_intent_id;
      SELECT * INTO connection FROM network_connections WHERE id=NEW.network_connection_id;
      SELECT * INTO capability FROM network_connection_capabilities WHERE id=NEW.network_capability_id;
      SELECT * INTO proposal FROM network_capability_proposals WHERE id=NEW.accepted_proposal_id;
      IF intent_row.id IS NULL OR capability.network_connection_id IS DISTINCT FROM NEW.network_connection_id OR capability.accepted_proposal_id IS DISTINCT FROM NEW.accepted_proposal_id OR capability.status <> 'ACTIVE' OR proposal.status <> 'ACCEPTED' OR ROW(intent_row.patient_account_id,intent_row.booking_actor_account_id,intent_row.booking_tenant_id,intent_row.service_exposure_id,intent_row.service_offering_id,intent_row.service_offering_version_id,intent_row.service_offering_price_id,intent_row.scheduling_mode,intent_row.queue_window_id) IS DISTINCT FROM ROW(NEW.patient_account_id,NEW.booking_actor_account_id,NEW.originating_tenant_id,NEW.service_exposure_id,NEW.service_offering_id,NEW.service_offering_version_id,NEW.service_offering_price_id,NEW.scheduling_mode,NEW.queue_window_id) THEN RAISE EXCEPTION 'network booking context is inconsistent'; END IF;
      IF NEW.booking_kind='CLINIC_DOCTOR_DELEGATED' THEN
        SELECT * INTO delegated_authorization FROM patient_clinic_booking_authorizations WHERE id=NEW.patient_clinic_booking_authorization_id;
        IF intent_row.booking_relationship <> 'CLINIC_DOCTOR' OR intent_row.capability_key <> 'BOOK' OR connection.connection_kind <> 'CLINIC_DOCTOR' OR connection.doctor_profile_id IS DISTINCT FROM intent_row.provider_doctor_profile_id OR capability.capability_key <> 'BOOK' OR capability.grantor_doctor_profile_id IS DISTINCT FROM intent_row.provider_doctor_profile_id OR proposal.proposer_doctor_profile_id IS DISTINCT FROM intent_row.provider_doctor_profile_id OR delegated_authorization.id IS NULL OR delegated_authorization.patient_account_id IS DISTINCT FROM NEW.patient_account_id OR delegated_authorization.delegated_clinic_id IS DISTINCT FROM capability.grantee_clinic_id OR delegated_authorization.delegated_tenant_id IS DISTINCT FROM NEW.originating_tenant_id OR delegated_authorization.target_doctor_profile_id IS DISTINCT FROM intent_row.provider_doctor_profile_id OR delegated_authorization.service_exposure_id IS DISTINCT FROM NEW.service_exposure_id OR delegated_authorization.service_offering_id IS DISTINCT FROM NEW.service_offering_id OR delegated_authorization.status <> 'CONSUMED' OR delegated_authorization.consuming_appointment_intent_id IS DISTINCT FROM NEW.appointment_intent_id THEN RAISE EXCEPTION 'delegated network booking context is inconsistent'; END IF;
      ELSE
        SELECT * INTO referral FROM appointment_referrals WHERE id=NEW.appointment_referral_id;
        IF intent_row.booking_relationship <> 'CLINIC_CLINIC' OR intent_row.capability_key <> 'REFER' OR capability.capability_key <> 'REFER' OR referral.id IS NULL OR referral.network_connection_id IS DISTINCT FROM NEW.network_connection_id OR referral.network_capability_id IS DISTINCT FROM NEW.network_capability_id OR referral.accepted_proposal_id IS DISTINCT FROM NEW.accepted_proposal_id OR referral.patient_account_id IS DISTINCT FROM NEW.patient_account_id OR referral.receiving_tenant_id IS DISTINCT FROM NEW.originating_tenant_id OR referral.destination_service_exposure_id IS DISTINCT FROM NEW.service_exposure_id OR referral.destination_service_offering_id IS DISTINCT FROM NEW.service_offering_id OR referral.status <> 'CONSUMED' OR referral.consuming_appointment_intent_id IS DISTINCT FROM NEW.appointment_intent_id THEN RAISE EXCEPTION 'referral network booking context is inconsistent'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER network_booking_contexts_integrity BEFORE INSERT OR UPDATE OR DELETE ON network_booking_contexts FOR EACH ROW EXECUTE FUNCTION network_booking_context_guard();
    CREATE FUNCTION network_booking_context_commit_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.scheduling_mode='QUEUE' AND NOT EXISTS (
        SELECT 1 FROM queue_entries entry
        WHERE entry.id=NEW.queue_entry_id AND entry.appointment_intent_id=NEW.appointment_intent_id AND entry.queue_window_id=NEW.queue_window_id
      ) THEN RAISE EXCEPTION 'queue network booking context requires exact queue entry'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM appointment_intents intent
        WHERE intent.id=NEW.appointment_intent_id
          AND intent.network_booking_context_id=NEW.id
          AND (NEW.queue_entry_id IS NULL OR intent.queue_entry_id=NEW.queue_entry_id)
      ) THEN RAISE EXCEPTION 'network booking context must be attached to its exact appointment intent'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER network_booking_contexts_commit_integrity
      AFTER INSERT ON network_booking_contexts DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION network_booking_context_commit_guard();
    CREATE FUNCTION delegated_authorization_consumption_context_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.status='CONSUMED' AND NOT EXISTS (
        SELECT 1 FROM network_booking_contexts context
        WHERE context.patient_clinic_booking_authorization_id=NEW.id
          AND context.appointment_intent_id=NEW.consuming_appointment_intent_id
      ) THEN RAISE EXCEPTION 'consumed delegated authorization requires exact network booking context'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER delegated_authorizations_consumption_context_integrity
      AFTER INSERT OR UPDATE OF status,consuming_appointment_intent_id ON patient_clinic_booking_authorizations DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION delegated_authorization_consumption_context_guard();
    CREATE FUNCTION referral_consumption_context_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.status='CONSUMED' AND NOT EXISTS (
        SELECT 1 FROM network_booking_contexts context
        WHERE context.appointment_referral_id=NEW.id
          AND context.appointment_intent_id=NEW.consuming_appointment_intent_id
      ) THEN RAISE EXCEPTION 'consumed referral requires exact network booking context'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_referrals_consumption_context_integrity
      AFTER INSERT OR UPDATE OF status,consuming_appointment_intent_id ON appointment_referrals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION referral_consumption_context_guard();

    CREATE FUNCTION queue_entry_guard() RETURNS trigger AS $$
    DECLARE window_row queue_windows%ROWTYPE; intent_row appointment_intents%ROWTYPE;
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'queue entry evidence cannot be deleted'; END IF;
      SELECT * INTO window_row FROM queue_windows WHERE id=NEW.queue_window_id;
      SELECT * INTO intent_row FROM appointment_intents WHERE id=NEW.appointment_intent_id;
      IF window_row.id IS NULL OR intent_row.id IS NULL OR NEW.maximum_capacity IS DISTINCT FROM window_row.maximum_capacity OR ROW(intent_row.patient_account_id,intent_row.booking_actor_account_id,intent_row.scheduling_mode,intent_row.queue_window_id,intent_row.service_offering_version_id) IS DISTINCT FROM ROW(NEW.patient_account_id,NEW.booking_actor_account_id,'QUEUE'::text,NEW.queue_window_id,window_row.service_offering_version_id) THEN RAISE EXCEPTION 'queue entry context is inconsistent'; END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.queue_window_id,OLD.appointment_intent_id,OLD.patient_account_id,OLD.booking_actor_account_id,OLD.maximum_capacity,OLD.queue_position,OLD.created_at) IS DISTINCT FROM ROW(NEW.queue_window_id,NEW.appointment_intent_id,NEW.patient_account_id,NEW.booking_actor_account_id,NEW.maximum_capacity,NEW.queue_position,NEW.created_at) THEN RAISE EXCEPTION 'queue entry evidence is immutable'; END IF;
        IF OLD.capacity_status='RELEASED' AND NEW.capacity_status <> 'RELEASED' THEN RAISE EXCEPTION 'released queue entry capacity cannot reactivate'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER queue_entries_integrity BEFORE INSERT OR UPDATE OR DELETE ON queue_entries FOR EACH ROW EXECUTE FUNCTION queue_entry_guard();
    CREATE FUNCTION queue_entry_intent_attachment_guard() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM appointment_intents intent
        WHERE intent.id=NEW.appointment_intent_id
          AND intent.queue_entry_id=NEW.id
          AND intent.queue_window_id=NEW.queue_window_id
      ) THEN RAISE EXCEPTION 'queue entry must be attached to its exact appointment intent'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER queue_entries_intent_attachment_integrity
      AFTER INSERT OR UPDATE OF appointment_intent_id,queue_window_id ON queue_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION queue_entry_intent_attachment_guard();
    CREATE FUNCTION queue_entry_status_guard() RETURNS trigger AS $$
    DECLARE appointment_status text; intent_state text;
    BEGIN
      SELECT status INTO appointment_status FROM appointments WHERE appointment_intent_id=NEW.appointment_intent_id;
      SELECT state INTO intent_state FROM appointment_intents WHERE id=NEW.appointment_intent_id;
      IF (NEW.queue_status='WAITING' AND appointment_status IS NOT NULL AND appointment_status NOT IN ('PAYMENT_PENDING','CONFIRMED'))
        OR (NEW.queue_status='CALLED' AND appointment_status IS DISTINCT FROM 'IN_PROGRESS')
        OR (NEW.queue_status='COMPLETED' AND appointment_status IS DISTINCT FROM 'COMPLETED')
        OR (NEW.queue_status='CANCELLED' AND NOT (appointment_status IS NOT DISTINCT FROM 'CANCELLED' OR (appointment_status IS NULL AND intent_state IN ('CANCELLED','EXPIRED'))))
        OR NEW.queue_status='NO_SHOW'
      THEN RAISE EXCEPTION 'queue entry status is inconsistent with appointment lifecycle'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER queue_entries_status_integrity
      AFTER INSERT OR UPDATE OF queue_status ON queue_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION queue_entry_status_guard();
    CREATE FUNCTION queue_entry_capacity_guard() RETURNS trigger AS $$
    DECLARE capacity_count integer; capacity_limit integer; capacity_delta integer; next_position integer;
    BEGIN
      SELECT maximum_capacity INTO capacity_limit FROM queue_windows WHERE id=NEW.queue_window_id FOR UPDATE;
      IF capacity_limit IS NULL THEN RAISE EXCEPTION 'queue window capacity context is inconsistent'; END IF;
      IF TG_OP='INSERT' THEN
        SELECT coalesce(max(queue_position),0)+1 INTO next_position FROM queue_entries WHERE queue_window_id=NEW.queue_window_id;
        NEW.queue_position := next_position;
      END IF;
      SELECT count(*) INTO capacity_count FROM queue_entries WHERE queue_window_id=NEW.queue_window_id AND capacity_status='ACTIVE';
      capacity_delta := CASE
        WHEN TG_OP='INSERT' AND NEW.capacity_status='ACTIVE' THEN 1
        WHEN TG_OP='UPDATE' AND OLD.capacity_status <> 'ACTIVE' AND NEW.capacity_status='ACTIVE' THEN 1
        ELSE 0
      END;
      IF capacity_count + capacity_delta > capacity_limit THEN RAISE EXCEPTION 'queue window capacity is exceeded'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER queue_entries_capacity_integrity BEFORE INSERT OR UPDATE OF queue_window_id,capacity_status ON queue_entries FOR EACH ROW EXECUTE FUNCTION queue_entry_capacity_guard();
    CREATE FUNCTION queue_entry_capacity_lifecycle_guard() RETURNS trigger AS $$
    DECLARE appointment_status text; intent_state text;
    BEGIN
      IF OLD.capacity_status='ACTIVE' AND NEW.capacity_status='RELEASED' THEN
        SELECT status INTO appointment_status FROM appointments WHERE appointment_intent_id=NEW.appointment_intent_id;
        SELECT state INTO intent_state FROM appointment_intents WHERE id=NEW.appointment_intent_id;
        IF NOT (appointment_status IS NOT DISTINCT FROM 'CANCELLED'
          OR (appointment_status IS NULL AND intent_state IN ('CANCELLED','EXPIRED'))
          OR EXISTS (SELECT 1 FROM appointment_reschedules reschedule JOIN appointments source ON source.id=reschedule.source_appointment_id WHERE source.appointment_intent_id=NEW.appointment_intent_id)
        ) THEN RAISE EXCEPTION 'queue entry capacity release is inconsistent with appointment lifecycle'; END IF;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER queue_entries_capacity_lifecycle_integrity
      AFTER UPDATE OF capacity_status ON queue_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION queue_entry_capacity_lifecycle_guard();

    CREATE FUNCTION appointment_intent_queue_window_lock_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.scheduling_mode='QUEUE' THEN
        PERFORM 1 FROM queue_windows WHERE id=NEW.queue_window_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'queue window capacity context is inconsistent'; END IF;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_intents_queue_window_lock_integrity
      BEFORE INSERT OR UPDATE OF queue_window_id ON appointment_intents
      FOR EACH ROW EXECUTE FUNCTION appointment_intent_queue_window_lock_guard();

    CREATE FUNCTION appointment_intent_network_context_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND ROW(OLD.scheduling_mode,OLD.queue_window_id) IS DISTINCT FROM ROW(NEW.scheduling_mode,NEW.queue_window_id) THEN RAISE EXCEPTION 'appointment intent scheduling context is immutable'; END IF;
      IF TG_OP='UPDATE' AND OLD.queue_entry_id IS NOT NULL AND OLD.queue_entry_id IS DISTINCT FROM NEW.queue_entry_id THEN RAISE EXCEPTION 'appointment intent queue entry is immutable'; END IF;
      IF TG_OP='UPDATE' AND OLD.network_booking_context_id IS NOT NULL AND OLD.network_booking_context_id IS DISTINCT FROM NEW.network_booking_context_id THEN RAISE EXCEPTION 'appointment intent network context is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_intent_network_context_integrity BEFORE UPDATE ON appointment_intents FOR EACH ROW EXECUTE FUNCTION appointment_intent_network_context_guard();
    CREATE FUNCTION appointment_intent_queue_entry_context_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.queue_entry_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM queue_entries entry
        WHERE entry.id=NEW.queue_entry_id AND entry.appointment_intent_id=NEW.id AND entry.queue_window_id=NEW.queue_window_id
      ) THEN RAISE EXCEPTION 'appointment intent queue entry context is inconsistent'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_intent_queue_entry_context_integrity
      AFTER INSERT OR UPDATE OF queue_entry_id ON appointment_intents DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_intent_queue_entry_context_guard();
    CREATE FUNCTION appointment_network_context_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND ROW(OLD.scheduling_mode,OLD.queue_window_id,OLD.queue_entry_id,OLD.network_booking_context_id) IS DISTINCT FROM ROW(NEW.scheduling_mode,NEW.queue_window_id,NEW.queue_entry_id,NEW.network_booking_context_id) THEN RAISE EXCEPTION 'appointment network scheduling context is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_network_context_integrity BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_network_context_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM network_booking_contexts) OR EXISTS (SELECT 1 FROM referral_consent_events) OR EXISTS (SELECT 1 FROM appointment_referrals) OR EXISTS (SELECT 1 FROM patient_clinic_booking_authorizations) OR EXISTS (SELECT 1 FROM queue_entries) OR EXISTS (SELECT 1 FROM queue_windows) OR EXISTS (SELECT 1 FROM service_offering_version_queue_policies) OR EXISTS (SELECT 1 FROM patient_delegated_booking_authorization_policy_versions) OR EXISTS (SELECT 1 FROM appointment_referral_policy_versions) OR EXISTS (SELECT 1 FROM retention_policy_versions WHERE record_category='REFERRAL') OR EXISTS (SELECT 1 FROM legal_holds WHERE record_category='REFERRAL') THEN RAISE EXCEPTION 'cannot roll back Phase 5.8 network booking persistence while evidence exists'; END IF;
    END $$;
    DROP TRIGGER appointment_network_context_integrity ON appointments;
    DROP FUNCTION appointment_network_context_guard();
    DROP TRIGGER appointment_intent_queue_entry_context_integrity ON appointment_intents;
    DROP FUNCTION appointment_intent_queue_entry_context_guard();
    DROP TRIGGER IF EXISTS appointment_intents_queue_window_lock_integrity ON appointment_intents;
    DROP FUNCTION IF EXISTS appointment_intent_queue_window_lock_guard();
    DROP TRIGGER appointment_intent_network_context_integrity ON appointment_intents;
    DROP FUNCTION appointment_intent_network_context_guard();
    DROP TRIGGER queue_entries_capacity_integrity ON queue_entries;
    DROP FUNCTION queue_entry_capacity_guard();
    DROP TRIGGER queue_entries_capacity_lifecycle_integrity ON queue_entries;
    DROP FUNCTION queue_entry_capacity_lifecycle_guard();
    DROP TRIGGER queue_entries_integrity ON queue_entries;
    DROP FUNCTION queue_entry_guard();
    DROP TRIGGER queue_entries_status_integrity ON queue_entries;
    DROP FUNCTION queue_entry_status_guard();
    DROP TRIGGER queue_entries_intent_attachment_integrity ON queue_entries;
    DROP FUNCTION queue_entry_intent_attachment_guard();
    ALTER TABLE appointments DROP CONSTRAINT appointments_queue_context_check;
    ALTER TABLE appointments DROP CONSTRAINT appointments_scheduling_mode_check;
    ALTER TABLE appointments DROP COLUMN network_booking_context_id;
    ALTER TABLE appointments DROP COLUMN queue_entry_id;
    ALTER TABLE appointments DROP COLUMN queue_window_id;
    ALTER TABLE appointments DROP COLUMN scheduling_mode;
    ALTER TABLE network_booking_contexts DROP CONSTRAINT network_booking_contexts_queue_entry_fk;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_queue_entry_fk;
    DROP TABLE queue_entries;
    DROP TRIGGER network_booking_contexts_commit_integrity ON network_booking_contexts;
    DROP FUNCTION network_booking_context_commit_guard();
    DROP TRIGGER appointment_referrals_consumption_context_integrity ON appointment_referrals;
    DROP FUNCTION referral_consumption_context_guard();
    DROP TRIGGER delegated_authorizations_consumption_context_integrity ON patient_clinic_booking_authorizations;
    DROP FUNCTION delegated_authorization_consumption_context_guard();
    DROP TRIGGER network_booking_contexts_integrity ON network_booking_contexts;
    DROP FUNCTION network_booking_context_guard();
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_network_booking_context_fk;
    DROP TABLE network_booking_contexts;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_queue_context_check;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_scheduling_mode_check;
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_check CHECK ((booking_relationship = 'CLINIC_DOCTOR') = (capability_key = 'BOOK'));
    ALTER TABLE appointment_intents DROP CONSTRAINT appointment_intents_booking_relationship_check;
    ALTER TABLE appointment_intents ADD CONSTRAINT appointment_intents_booking_relationship_check CHECK (booking_relationship IN ('PATIENT_PROVIDER','CLINIC_DOCTOR'));
    ALTER TABLE appointment_intents DROP COLUMN network_booking_context_id;
    ALTER TABLE appointment_intents DROP COLUMN queue_entry_id;
    ALTER TABLE appointment_intents DROP COLUMN queue_window_id;
    ALTER TABLE appointment_intents DROP COLUMN scheduling_mode;
    DROP TRIGGER appointment_referral_consent_transition_integrity ON appointment_referrals;
    DROP FUNCTION appointment_referral_consent_transition_guard();
    DROP TRIGGER referral_consent_events_integrity ON referral_consent_events;
    DROP FUNCTION referral_consent_event_guard();
    DROP TRIGGER referral_consent_events_state_integrity ON referral_consent_events;
    DROP FUNCTION referral_consent_event_state_guard();
    DROP TABLE referral_consent_events;
    DROP TRIGGER appointment_referrals_integrity ON appointment_referrals;
    DROP FUNCTION appointment_referral_guard();
    DROP TABLE appointment_referrals;
    DROP TRIGGER patient_clinic_booking_authorizations_integrity ON patient_clinic_booking_authorizations;
    DROP FUNCTION patient_clinic_booking_authorization_guard();
    DROP TABLE patient_clinic_booking_authorizations;
    DROP TRIGGER queue_windows_integrity ON queue_windows;
    DROP FUNCTION queue_window_guard();
    DROP TABLE queue_windows;
    DROP TRIGGER service_offering_version_queue_policies_integrity ON service_offering_version_queue_policies;
    DROP FUNCTION queue_policy_guard();
    DROP TABLE service_offering_version_queue_policies;
    DROP TRIGGER appointment_referral_policy_versions_guard ON appointment_referral_policy_versions;
    DROP TRIGGER patient_delegated_booking_authorization_policy_versions_guard ON patient_delegated_booking_authorization_policy_versions;
    DROP FUNCTION phase58_policy_version_guard();
    DROP TABLE appointment_referral_policy_versions;
    DROP TABLE patient_delegated_booking_authorization_policy_versions;
    ALTER TABLE legal_holds DROP CONSTRAINT legal_holds_record_category_check;
    ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_record_category_check CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK'));
    ALTER TABLE retention_policy_versions DROP CONSTRAINT retention_policy_versions_record_category_check;
    ALTER TABLE retention_policy_versions ADD CONSTRAINT retention_policy_versions_record_category_check CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK'));
  `);
};

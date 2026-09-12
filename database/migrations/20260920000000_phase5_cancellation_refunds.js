/* theCliniQ Phase 5.5 cancellation and refund foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE refund_policy_versions
      ADD COLUMN priority integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT refund_policy_versions_priority_check CHECK (priority >= 0);

    CREATE TABLE refund_policy_scopes (
      id uuid PRIMARY KEY,
      refund_policy_version_id uuid NOT NULL UNIQUE REFERENCES refund_policy_versions(id) ON DELETE RESTRICT,
      scope_kind text NOT NULL,
      service_offering_id uuid REFERENCES service_offerings(id) ON DELETE RESTRICT,
      provider_key text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (scope_kind IN ('GLOBAL','PROVIDER','SERVICE','SERVICE_PROVIDER')),
      CHECK (
        (scope_kind='GLOBAL' AND service_offering_id IS NULL AND provider_key IS NULL) OR
        (scope_kind='PROVIDER' AND service_offering_id IS NULL AND provider_key IS NOT NULL) OR
        (scope_kind='SERVICE' AND service_offering_id IS NOT NULL AND provider_key IS NULL) OR
        (scope_kind='SERVICE_PROVIDER' AND service_offering_id IS NOT NULL AND provider_key IS NOT NULL)
      )
    );
    CREATE INDEX refund_policy_scopes_lookup ON refund_policy_scopes(provider_key,service_offering_id);

    CREATE FUNCTION refund_policy_data_guard() RETURNS trigger AS $$
    DECLARE outcome text; basis text; states jsonb; percentage integer; state text;
    BEGIN
      outcome := NEW.policy_data->>'refundOutcome';
      basis := NEW.policy_data->>'refundBasis';
      states := NEW.policy_data->'paymentStates';
      IF outcome NOT IN ('NONE','FULL','PERCENTAGE') OR basis <> 'PAYMENT_AMOUNT'
        OR jsonb_typeof(states) <> 'array' OR jsonb_array_length(states) = 0
        OR jsonb_typeof(NEW.policy_data->'cancellationWindowSeconds') <> 'number'
        OR (NEW.policy_data->>'cancellationWindowSeconds')::numeric < 0
        OR (NEW.policy_data->>'cancellationWindowSeconds')::numeric <> trunc((NEW.policy_data->>'cancellationWindowSeconds')::numeric)
        OR jsonb_typeof(NEW.policy_data->'allowInProgress') <> 'boolean' THEN
        RAISE EXCEPTION 'invalid structured refund policy data';
      END IF;
      IF outcome='PERCENTAGE' THEN
        IF jsonb_typeof(NEW.policy_data->'percentageBps') <> 'number' OR (NEW.policy_data->>'percentageBps')::numeric <> trunc((NEW.policy_data->>'percentageBps')::numeric) THEN RAISE EXCEPTION 'percentage refund policy requires integer percentageBps'; END IF;
        percentage := (NEW.policy_data->>'percentageBps')::integer;
        IF percentage < 0 OR percentage > 10000 THEN RAISE EXCEPTION 'percentageBps must be between 0 and 10000'; END IF;
      ELSIF NEW.policy_data ? 'percentageBps' THEN
        RAISE EXCEPTION 'percentageBps is only valid for percentage refund policies';
      END IF;
      FOR state IN SELECT jsonb_array_elements_text(states) LOOP
        IF state NOT IN ('PENDING','SUCCEEDED','FAILED','EXPIRED','RECONCILIATION_REQUIRED') THEN
          RAISE EXCEPTION 'refund policy contains an unsupported payment state';
        END IF;
      END LOOP;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER refund_policy_versions_structured_data
      BEFORE INSERT OR UPDATE OF policy_data ON refund_policy_versions
      FOR EACH ROW EXECUTE FUNCTION refund_policy_data_guard();

    CREATE TABLE appointment_cancellation_decisions (
      id uuid PRIMARY KEY,
      appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
      slot_reservation_id uuid NOT NULL REFERENCES slot_reservations(id) ON DELETE RESTRICT,
      financial_allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
      actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      previous_appointment_status text NOT NULL,
      resulting_appointment_status text NOT NULL DEFAULT 'CANCELLED',
      reason_category text NOT NULL,
      authorization_context jsonb NOT NULL DEFAULT '{}'::jsonb,
      cancellation_at timestamptz NOT NULL,
      refund_policy_version_id uuid NOT NULL REFERENCES refund_policy_versions(id) ON DELETE RESTRICT,
      refund_outcome text NOT NULL,
      refund_amount_minor bigint NOT NULL,
      currency char(3) NOT NULL,
      capacity_released boolean NOT NULL,
      settlement_consequence text NOT NULL,
      idempotency_key text NOT NULL,
      request_fingerprint text NOT NULL,
      audit_event_id uuid REFERENCES audit_events(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (previous_appointment_status IN ('CONFIRMED','IN_PROGRESS','PAYMENT_PENDING')),
      CHECK (resulting_appointment_status='CANCELLED'),
      CHECK (char_length(btrim(reason_category)) > 0),
      CHECK (jsonb_typeof(authorization_context)='object'),
      CHECK (refund_outcome IN ('NO_REFUND','REFUND_REQUESTED','RECONCILIATION_REQUIRED')),
      CHECK (refund_amount_minor >= 0),
      CHECK (currency ~ '^[A-Z]{3}$'),
      CHECK (settlement_consequence IN ('NONE','ON_HOLD','RECONCILIATION_REQUIRED')),
      CHECK ((refund_outcome='REFUND_REQUESTED') = (refund_amount_minor > 0)),
      UNIQUE (actor_account_id,idempotency_key)
    );
    CREATE INDEX appointment_cancellation_decisions_payment ON appointment_cancellation_decisions(payment_id);

    ALTER TABLE refunds
      ADD COLUMN appointment_cancellation_decision_id uuid UNIQUE REFERENCES appointment_cancellation_decisions(id) ON DELETE RESTRICT;
    CREATE INDEX refunds_cancellation_decision ON refunds(appointment_cancellation_decision_id);

    CREATE TABLE refund_attempts (
      id uuid PRIMARY KEY,
      refund_id uuid NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
      attempt_number integer NOT NULL,
      status text NOT NULL,
      provider_key text NOT NULL,
      idempotency_key text NOT NULL,
      provider_refund_id text,
      failure_code text,
      reconciliation_required_at timestamptz,
      claimed_at timestamptz NOT NULL DEFAULT current_timestamp,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('CLAIMED','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED')),
      CHECK (attempt_number > 0),
      UNIQUE (refund_id,attempt_number),
      UNIQUE (provider_key,idempotency_key),
      UNIQUE (provider_key,provider_refund_id)
    );
    CREATE INDEX refund_attempts_claimable ON refund_attempts(refund_id,status,attempt_number);

    CREATE TABLE appointment_cancellation_financial_consequences (
      id uuid PRIMARY KEY,
      appointment_cancellation_decision_id uuid NOT NULL UNIQUE REFERENCES appointment_cancellation_decisions(id) ON DELETE RESTRICT,
      financial_allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      refund_id uuid UNIQUE REFERENCES refunds(id) ON DELETE RESTRICT,
      consequence_status text NOT NULL,
      amount_minor bigint NOT NULL,
      currency char(3) NOT NULL,
      settlement_consequence text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (consequence_status IN ('NO_REFUND','REFUND_REQUESTED','RECONCILIATION_REQUIRED')),
      CHECK (amount_minor >= 0),
      CHECK (currency ~ '^[A-Z]{3}$'),
      CHECK (settlement_consequence IN ('NONE','ON_HOLD','RECONCILIATION_REQUIRED'))
    );

    CREATE FUNCTION appointment_cancellation_decision_guard() RETURNS trigger AS $$
    DECLARE appointment_status text; event_exists boolean;
    BEGIN
      SELECT status INTO appointment_status FROM appointments WHERE id=NEW.appointment_id;
      SELECT EXISTS(SELECT 1 FROM appointment_events WHERE appointment_id=NEW.appointment_id AND event_type='CANCELLED' AND previous_status=NEW.previous_appointment_status AND resulting_status='CANCELLED' AND context->>'cancellationDecisionId'=NEW.id::text) INTO event_exists;
      IF appointment_status <> 'CANCELLED' OR NOT event_exists THEN RAISE EXCEPTION 'cancellation decision requires matching cancelled appointment event'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_cancellation_decision_consistency
      AFTER INSERT ON appointment_cancellation_decisions DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_cancellation_decision_guard();
    CREATE FUNCTION appointment_cancellation_state_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.status='CANCELLED' AND OLD.status <> 'CANCELLED' AND NOT EXISTS (
        SELECT 1 FROM appointment_cancellation_decisions
        WHERE appointment_id=NEW.id AND previous_appointment_status=OLD.status
      ) THEN RAISE EXCEPTION 'cancelled appointment requires immutable cancellation decision'; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_cancellation_state_consistency
      AFTER UPDATE OF status ON appointments DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_cancellation_state_guard();
    CREATE FUNCTION appointment_cancellation_decision_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'appointment cancellation decision cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER appointment_cancellation_decisions_immutable
      BEFORE UPDATE OR DELETE ON appointment_cancellation_decisions
      FOR EACH ROW EXECUTE FUNCTION appointment_cancellation_decision_immutable();
    CREATE TRIGGER appointment_cancellation_financial_consequences_immutable
      BEFORE UPDATE OR DELETE ON appointment_cancellation_financial_consequences
      FOR EACH ROW EXECUTE FUNCTION appointment_cancellation_decision_immutable();

    CREATE FUNCTION refund_integrity_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund cannot be deleted'; END IF;
      IF NEW.payment_id <> OLD.payment_id OR NEW.allocation_snapshot_id <> OLD.allocation_snapshot_id
        OR NEW.provider_key <> OLD.provider_key OR NEW.currency <> OLD.currency OR NEW.amount_minor <> OLD.amount_minor
        OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.refund_policy_version_id IS DISTINCT FROM OLD.refund_policy_version_id
        OR NEW.appointment_cancellation_decision_id IS DISTINCT FROM OLD.appointment_cancellation_decision_id
        OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) THEN
        RAISE EXCEPTION 'refund historical context cannot be changed';
      END IF;
      IF NEW.status <> OLD.status AND NOT ((OLD.status='REQUESTED' AND NEW.status IN ('PROCESSING','FAILED')) OR (OLD.status='PROCESSING' AND NEW.status IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'))) THEN
        RAISE EXCEPTION 'invalid refund state transition';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER refunds_integrity BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refund_integrity_guard();
    CREATE FUNCTION refund_attempt_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund attempt cannot be deleted'; END IF;
      IF NEW.refund_id <> OLD.refund_id OR NEW.attempt_number <> OLD.attempt_number OR NEW.provider_key <> OLD.provider_key OR NEW.idempotency_key <> OLD.idempotency_key
        OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) THEN RAISE EXCEPTION 'refund attempt context cannot be changed'; END IF;
      IF NEW.status <> OLD.status AND NOT ((OLD.status='CLAIMED' AND NEW.status IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'))) THEN RAISE EXCEPTION 'invalid refund attempt state transition'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER refund_attempts_integrity BEFORE UPDATE OR DELETE ON refund_attempts FOR EACH ROW EXECUTE FUNCTION refund_attempt_guard();

    /* Cross-table cancellation financial evidence is enforced even for direct SQL. */
    CREATE FUNCTION appointment_cancellation_financial_context_guard() RETURNS trigger AS $$
    DECLARE appointment_row appointments%ROWTYPE;
    DECLARE payment_row payments%ROWTYPE;
    DECLARE payment_fact_count integer;
    BEGIN
      SELECT * INTO appointment_row FROM appointments WHERE id=NEW.appointment_id;
      IF appointment_row.id IS NULL
        OR appointment_row.slot_reservation_id IS DISTINCT FROM NEW.slot_reservation_id
        OR appointment_row.financial_allocation_snapshot_id IS DISTINCT FROM NEW.financial_allocation_snapshot_id THEN
        RAISE EXCEPTION 'cancellation decision financial context is inconsistent';
      END IF;
      SELECT count(*) INTO payment_fact_count FROM payments
        WHERE payment_intent_id=appointment_row.payment_intent_id;
      IF payment_fact_count=0 THEN
        IF NEW.payment_id IS NOT NULL THEN
          RAISE EXCEPTION 'cancellation decision payment context is inconsistent';
        END IF;
      ELSIF payment_fact_count<>1 THEN
        RAISE EXCEPTION 'cancellation decision payment context is ambiguous';
      ELSE
        SELECT * INTO payment_row FROM payments WHERE id=NEW.payment_id;
        IF payment_row.id IS NULL OR payment_row.payment_intent_id IS DISTINCT FROM appointment_row.payment_intent_id
          OR payment_row.currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'cancellation decision payment context is inconsistent';
        END IF;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER appointment_cancellation_financial_context_integrity
      AFTER INSERT OR UPDATE ON appointment_cancellation_decisions DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION appointment_cancellation_financial_context_guard();

    CREATE FUNCTION refund_cancellation_financial_guard() RETURNS trigger AS $$
    DECLARE decision_row appointment_cancellation_decisions%ROWTYPE;
    DECLARE payment_row payments%ROWTYPE;
    BEGIN
      IF NEW.appointment_cancellation_decision_id IS NULL THEN RETURN NULL; END IF;
      SELECT * INTO decision_row FROM appointment_cancellation_decisions WHERE id=NEW.appointment_cancellation_decision_id;
      SELECT * INTO payment_row FROM payments WHERE id=NEW.payment_id;
      IF decision_row.id IS NULL OR payment_row.id IS NULL
        OR decision_row.payment_id IS DISTINCT FROM NEW.payment_id
        OR decision_row.financial_allocation_snapshot_id IS DISTINCT FROM NEW.allocation_snapshot_id
        OR decision_row.refund_policy_version_id IS DISTINCT FROM NEW.refund_policy_version_id
        OR decision_row.currency IS DISTINCT FROM NEW.currency
        OR payment_row.currency IS DISTINCT FROM NEW.currency
        OR NEW.amount_minor > decision_row.refund_amount_minor
        OR NEW.amount_minor > payment_row.amount_minor
        OR (decision_row.refund_outcome='REFUND_REQUESTED') IS NOT TRUE THEN
        RAISE EXCEPTION 'refund cancellation financial context is inconsistent';
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER refund_cancellation_financial_integrity
      AFTER INSERT OR UPDATE ON refunds DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION refund_cancellation_financial_guard();

    CREATE FUNCTION cancellation_consequence_financial_guard() RETURNS trigger AS $$
    DECLARE decision_row appointment_cancellation_decisions%ROWTYPE;
    DECLARE refund_row refunds%ROWTYPE;
    BEGIN
      SELECT * INTO decision_row FROM appointment_cancellation_decisions WHERE id=NEW.appointment_cancellation_decision_id;
      IF decision_row.id IS NULL
        OR decision_row.financial_allocation_snapshot_id IS DISTINCT FROM NEW.financial_allocation_snapshot_id
        OR decision_row.currency IS DISTINCT FROM NEW.currency
        OR decision_row.refund_outcome IS DISTINCT FROM NEW.consequence_status
        OR decision_row.refund_amount_minor IS DISTINCT FROM NEW.amount_minor
        OR decision_row.settlement_consequence IS DISTINCT FROM NEW.settlement_consequence THEN
        RAISE EXCEPTION 'cancellation financial consequence is inconsistent';
      END IF;
      IF NEW.refund_id IS NOT NULL THEN
        SELECT * INTO refund_row FROM refunds WHERE id=NEW.refund_id;
        IF refund_row.id IS NULL OR refund_row.appointment_cancellation_decision_id IS DISTINCT FROM NEW.appointment_cancellation_decision_id
          OR refund_row.allocation_snapshot_id IS DISTINCT FROM NEW.financial_allocation_snapshot_id
          OR refund_row.amount_minor IS DISTINCT FROM NEW.amount_minor
          OR refund_row.currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'cancellation consequence refund context is inconsistent';
        END IF;
      ELSIF NEW.consequence_status='REFUND_REQUESTED' THEN
        RAISE EXCEPTION 'refund-requested consequence requires refund evidence';
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER cancellation_consequence_financial_integrity
      AFTER INSERT OR UPDATE ON appointment_cancellation_financial_consequences DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION cancellation_consequence_financial_guard();

    CREATE FUNCTION refund_provider_reference_immutable_guard() RETURNS trigger AS $$
    BEGIN
      IF (TG_OP='DELETE' AND OLD.reference_type='REFUND')
        OR (TG_OP='UPDATE' AND (OLD.reference_type='REFUND' OR NEW.reference_type='REFUND')) THEN
        RAISE EXCEPTION 'refund provider reference cannot be changed';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER refund_provider_references_immutable
      BEFORE UPDATE OR DELETE ON provider_references FOR EACH ROW EXECUTE FUNCTION refund_provider_reference_immutable_guard();

    /* A refund provider ID and its polymorphic provider-reference evidence are one immutable fact. */
    CREATE FUNCTION refund_provider_reference_integrity_guard() RETURNS trigger AS $$
    DECLARE refund_row refunds%ROWTYPE;
    DECLARE matching_reference_count integer;
    DECLARE refund_id uuid;
    DECLARE reference_provider_key text;
    DECLARE reference_value text;
    BEGIN
      IF TG_TABLE_NAME='refunds' THEN
        IF NEW.provider_refund_id IS NULL THEN RETURN NULL; END IF;
        SELECT count(*) INTO matching_reference_count FROM provider_references
          WHERE provider_key=NEW.provider_key AND reference_type='REFUND'
            AND provider_reference=NEW.provider_refund_id
            AND internal_entity_type='REFUND' AND internal_entity_id=NEW.id;
        IF matching_reference_count<>1 THEN
          RAISE EXCEPTION 'refund provider reference evidence is inconsistent';
        END IF;
        RETURN NULL;
      END IF;

      IF TG_OP='DELETE' THEN
        IF OLD.reference_type<>'REFUND' THEN RETURN NULL; END IF;
        refund_id := OLD.internal_entity_id;
        reference_provider_key := OLD.provider_key;
        reference_value := OLD.provider_reference;
      ELSE
        IF NEW.reference_type<>'REFUND' THEN RETURN NULL; END IF;
        refund_id := NEW.internal_entity_id;
        reference_provider_key := NEW.provider_key;
        reference_value := NEW.provider_reference;
      END IF;
      SELECT * INTO refund_row FROM refunds WHERE id=refund_id;
      IF refund_row.id IS NULL
        OR refund_row.provider_key IS DISTINCT FROM reference_provider_key
        OR refund_row.provider_refund_id IS DISTINCT FROM reference_value THEN
        RAISE EXCEPTION 'refund provider reference evidence is inconsistent';
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER refunds_provider_reference_integrity
      AFTER INSERT OR UPDATE ON refunds DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION refund_provider_reference_integrity_guard();
    CREATE CONSTRAINT TRIGGER provider_references_refund_integrity
      AFTER INSERT OR UPDATE OR DELETE ON provider_references DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION refund_provider_reference_integrity_guard();

    /* Cancellation may win the approved payment-confirmation race. */
    CREATE OR REPLACE FUNCTION appointment_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.status <> NEW.status AND NOT (
        (OLD.status='PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','PAYMENT_FAILED','EXPIRED','CANCELLED')) OR
        (OLD.status='CONFIRMED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
        (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
      ) THEN RAISE EXCEPTION 'appointment state transition is invalid'; END IF;
      NEW.updated_at=current_timestamp;
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
        OR (NEW.event_type='CANCELLED' AND NOT (NEW.previous_status IN ('PAYMENT_PENDING','CONFIRMED','IN_PROGRESS') AND NEW.resulting_status='CANCELLED'))
        OR (NEW.event_type IN ('RESCHEDULE_REQUESTED','RESCHEDULED','SUPPORT_EXCEPTION') AND NEW.resulting_status IS NOT NULL) THEN RAISE EXCEPTION 'appointment event transition is invalid'; END IF;
      IF NEW.resulting_status IS NOT NULL AND NEW.resulting_status IS DISTINCT FROM appointment_status THEN RAISE EXCEPTION 'appointment event resulting state is inconsistent'; END IF;
      IF NEW.event_type='SUPPORT_EXCEPTION' AND (NEW.reason IS NULL OR char_length(btrim(NEW.reason))=0) THEN RAISE EXCEPTION 'support appointment event requires reason'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM appointment_cancellation_decisions)
        OR EXISTS (SELECT 1 FROM refund_attempts)
        OR EXISTS (SELECT 1 FROM appointment_cancellation_financial_consequences)
        OR EXISTS (SELECT 1 FROM refunds WHERE appointment_cancellation_decision_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot roll back Phase 5.5 while cancellation or refund evidence exists';
      END IF;
    END $$;
    DROP TRIGGER provider_references_refund_integrity ON provider_references;
    DROP TRIGGER refunds_provider_reference_integrity ON refunds;
    DROP FUNCTION refund_provider_reference_integrity_guard();
    DROP TRIGGER refund_provider_references_immutable ON provider_references;
    DROP FUNCTION refund_provider_reference_immutable_guard();
    DROP TRIGGER cancellation_consequence_financial_integrity ON appointment_cancellation_financial_consequences;
    DROP FUNCTION cancellation_consequence_financial_guard();
    DROP TRIGGER refund_cancellation_financial_integrity ON refunds;
    DROP FUNCTION refund_cancellation_financial_guard();
    DROP TRIGGER appointment_cancellation_financial_context_integrity ON appointment_cancellation_decisions;
    DROP FUNCTION appointment_cancellation_financial_context_guard();
    DROP TRIGGER refund_attempts_integrity ON refund_attempts;
    DROP FUNCTION refund_attempt_guard();
    DROP TRIGGER refunds_integrity ON refunds;
    DROP FUNCTION refund_integrity_guard();
    DROP TRIGGER appointment_cancellation_financial_consequences_immutable ON appointment_cancellation_financial_consequences;
    DROP TRIGGER appointment_cancellation_decisions_immutable ON appointment_cancellation_decisions;
    DROP FUNCTION appointment_cancellation_decision_immutable();
    DROP TRIGGER appointment_cancellation_decision_consistency ON appointment_cancellation_decisions;
    DROP FUNCTION appointment_cancellation_decision_guard();
    DROP TRIGGER appointment_cancellation_state_consistency ON appointments;
    DROP FUNCTION appointment_cancellation_state_guard();
    DROP TABLE appointment_cancellation_financial_consequences;
    DROP TABLE refund_attempts;
    ALTER TABLE refunds DROP COLUMN appointment_cancellation_decision_id;
    DROP TABLE appointment_cancellation_decisions;
    DROP TRIGGER refund_policy_versions_structured_data ON refund_policy_versions;
    DROP FUNCTION refund_policy_data_guard();
    DROP TABLE refund_policy_scopes;
    ALTER TABLE refund_policy_versions DROP CONSTRAINT refund_policy_versions_priority_check;
    ALTER TABLE refund_policy_versions DROP COLUMN priority;
    CREATE OR REPLACE FUNCTION appointment_state_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.status <> NEW.status AND NOT (
        (OLD.status='PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','PAYMENT_FAILED','EXPIRED')) OR
        (OLD.status='CONFIRMED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
        (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
      ) THEN RAISE EXCEPTION 'appointment state transition is invalid'; END IF;
      NEW.updated_at=current_timestamp;
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
        OR (NEW.event_type IN ('RESCHEDULE_REQUESTED','RESCHEDULED','SUPPORT_EXCEPTION') AND NEW.resulting_status IS NOT NULL) THEN RAISE EXCEPTION 'appointment event transition is invalid'; END IF;
      IF NEW.resulting_status IS NOT NULL AND NEW.resulting_status IS DISTINCT FROM appointment_status THEN RAISE EXCEPTION 'appointment event resulting state is inconsistent'; END IF;
      IF NEW.event_type='SUPPORT_EXCEPTION' AND (NEW.reason IS NULL OR char_length(btrim(NEW.reason))=0) THEN RAISE EXCEPTION 'support appointment event requires reason'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
};

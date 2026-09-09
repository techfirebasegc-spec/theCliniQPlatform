/* theCliniQ Phase 4 financial foundation. No appointments, live payments, or payouts. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE commercial_rules (
      id uuid PRIMARY KEY, status text NOT NULL, rule_type text NOT NULL,
      created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','ACTIVE','DISABLED','ARCHIVED')),
      CHECK (rule_type IN ('PERCENTAGE','FIXED','FIXED_PLUS_PERCENTAGE','TIERED_CONTEXTUAL','DOCTOR_SPECIFIC','CLINIC_SPECIFIC','SERVICE_SPECIFIC','PROMOTIONAL','ZERO_COMMISSION','OTHER_APPROVED'))
    );
    CREATE TABLE commercial_rule_versions (
      id uuid PRIMARY KEY, commercial_rule_id uuid NOT NULL REFERENCES commercial_rules(id) ON DELETE RESTRICT,
      version_number integer NOT NULL, status text NOT NULL, priority integer NOT NULL,
      effective_from timestamptz NOT NULL, effective_until timestamptz,
      calculation_basis text NOT NULL, processing_fee_bearer text NOT NULL, discount_funding_source text,
      policy_data jsonb NOT NULL DEFAULT '{}'::jsonb, approved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')), CHECK (effective_until IS NULL OR effective_until > effective_from),
      CHECK (processing_fee_bearer IN ('THECLINIQ','PROVIDER','PATIENT','OTHER_APPROVED')),
      CHECK (jsonb_typeof(policy_data) = 'object'), UNIQUE (commercial_rule_id, version_number)
    );
    CREATE TABLE commercial_rule_scopes (
      id uuid PRIMARY KEY, commercial_rule_version_id uuid NOT NULL REFERENCES commercial_rule_versions(id) ON DELETE RESTRICT,
      scope_kind text NOT NULL, scope_reference_id uuid, scope_value text,
      CHECK (scope_kind IN ('GLOBAL','DOCTOR','CLINIC','SERVICE','BOOKING_CONTEXT','PROMOTION','OTHER_APPROVED')),
      CHECK ((scope_reference_id IS NOT NULL) OR (scope_value IS NOT NULL) OR scope_kind = 'GLOBAL')
    );
    CREATE UNIQUE INDEX commercial_rule_versions_active_scope_priority_unique ON commercial_rule_versions(commercial_rule_id, priority, effective_from) WHERE status = 'APPROVED';
    CREATE INDEX commercial_rule_scopes_lookup ON commercial_rule_scopes(scope_kind, scope_reference_id, scope_value);

    CREATE TABLE refund_policy_versions (
      id uuid PRIMARY KEY, status text NOT NULL, version_number integer NOT NULL, effective_from timestamptz NOT NULL, effective_until timestamptz,
      policy_data jsonb NOT NULL, approved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')), CHECK (effective_until IS NULL OR effective_until > effective_from), CHECK (jsonb_typeof(policy_data) = 'object'), UNIQUE (version_number)
    );
    CREATE TABLE settlement_policy_versions (
      id uuid PRIMARY KEY, status text NOT NULL, version_number integer NOT NULL, effective_from timestamptz NOT NULL, effective_until timestamptz,
      policy_data jsonb NOT NULL, approved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')), CHECK (effective_until IS NULL OR effective_until > effective_from), CHECK (jsonb_typeof(policy_data) = 'object'), UNIQUE (version_number)
    );
    CREATE TABLE retry_policy_versions (
      id uuid PRIMARY KEY, policy_category text NOT NULL, status text NOT NULL, version_number integer NOT NULL, effective_from timestamptz NOT NULL, effective_until timestamptz,
      policy_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (policy_category IN ('WEBHOOK','SETTLEMENT')), CHECK (status IN ('DRAFT','APPROVED','RETIRED')), CHECK (effective_until IS NULL OR effective_until > effective_from), CHECK (jsonb_typeof(policy_data) = 'object'), UNIQUE (policy_category, version_number)
    );
    CREATE TABLE retention_policy_versions (
      id uuid PRIMARY KEY, record_category text NOT NULL, status text NOT NULL, version_number integer NOT NULL, effective_from timestamptz NOT NULL, effective_until timestamptz,
      action text NOT NULL, policy_data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK')),
      CHECK (status IN ('DRAFT','APPROVED','RETIRED')), CHECK (action IN ('DELETE','ANONYMIZE','RETAIN')), CHECK (effective_until IS NULL OR effective_until > effective_from), CHECK (jsonb_typeof(policy_data) = 'object'), UNIQUE (record_category, version_number)
    );

    CREATE TABLE financial_allocation_snapshots (
      id uuid PRIMARY KEY, status text NOT NULL, currency char(3) NOT NULL, gross_amount_minor bigint NOT NULL,
      calculation_basis text NOT NULL, input_data jsonb NOT NULL DEFAULT '{}'::jsonb, selected_rule_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
      refund_policy_version_id uuid REFERENCES refund_policy_versions(id) ON DELETE RESTRICT,
      settlement_policy_version_id uuid REFERENCES settlement_policy_versions(id) ON DELETE RESTRICT,
      created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status = 'FINAL'), CHECK (gross_amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), CHECK (jsonb_typeof(input_data) = 'object'), CHECK (jsonb_typeof(selected_rule_versions) = 'array')
    );
    CREATE TABLE financial_allocation_components (
      id uuid PRIMARY KEY, allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      component_type text NOT NULL, amount_minor bigint NOT NULL, currency char(3) NOT NULL, rule_version_id uuid REFERENCES commercial_rule_versions(id) ON DELETE RESTRICT,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      CHECK (component_type IN ('GROSS','DISCOUNT','TAX','PROCESSING_FEE','PLATFORM_COMMISSION','PROVIDER_PAYABLE','OTHER_APPROVED_CHARGE','REFUND_BASIS','SETTLEMENT_BASIS')),
      CHECK (amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), CHECK (jsonb_typeof(metadata) = 'object'), UNIQUE (allocation_snapshot_id, component_type, id)
    );
    CREATE INDEX financial_allocation_components_snapshot ON financial_allocation_components(allocation_snapshot_id);

    CREATE TABLE payment_intents (
      id uuid PRIMARY KEY, provider_key text NOT NULL, status text NOT NULL, currency char(3) NOT NULL, amount_minor bigint NOT NULL,
      allocation_snapshot_id uuid REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      idempotency_key text NOT NULL, provider_order_id text, expires_at timestamptz, reconciliation_required_at timestamptz,
      created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp, updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('CREATED','PENDING_PROVIDER','AUTHORIZED','SUCCEEDED','FAILED','EXPIRED','RECONCILIATION_REQUIRED')),
      CHECK (amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), UNIQUE (provider_key, idempotency_key), UNIQUE (provider_key, provider_order_id)
    );
    CREATE TABLE payments (
      id uuid PRIMARY KEY, payment_intent_id uuid NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
      provider_key text NOT NULL, provider_payment_id text NOT NULL, status text NOT NULL, currency char(3) NOT NULL, amount_minor bigint NOT NULL,
      provider_fact jsonb NOT NULL DEFAULT '{}'::jsonb, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT current_timestamp, updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('PENDING','SUCCEEDED','FAILED','EXPIRED','RECONCILIATION_REQUIRED')), CHECK (amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), CHECK (jsonb_typeof(provider_fact) = 'object'), UNIQUE (provider_key, provider_payment_id)
    );
    CREATE TABLE refunds (
      id uuid PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT, allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      provider_key text NOT NULL, provider_refund_id text, status text NOT NULL, currency char(3) NOT NULL, amount_minor bigint NOT NULL, idempotency_key text NOT NULL,
      refund_policy_version_id uuid REFERENCES refund_policy_versions(id) ON DELETE RESTRICT, created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED')), CHECK (amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), UNIQUE (provider_key, idempotency_key), UNIQUE (provider_key, provider_refund_id)
    );
    CREATE TABLE settlements (
      id uuid PRIMARY KEY, provider_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      status text NOT NULL, currency char(3) NOT NULL, amount_minor bigint NOT NULL, idempotency_key text NOT NULL,
      settlement_policy_version_id uuid REFERENCES settlement_policy_versions(id) ON DELETE RESTRICT, appointment_completed_at timestamptz, hold_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('PENDING_ELIGIBILITY','ON_HOLD','ELIGIBLE','SCHEDULED','PROCESSING','SUCCEEDED','FAILED','REVERSED','RECONCILIATION_REQUIRED')),
      CHECK (amount_minor >= 0), CHECK (currency ~ '^[A-Z]{3}$'), CHECK (status NOT IN ('ELIGIBLE','SCHEDULED','PROCESSING','SUCCEEDED') OR appointment_completed_at IS NOT NULL), UNIQUE (provider_account_id, idempotency_key)
    );
    CREATE TABLE settlement_attempts (
      id uuid PRIMARY KEY, settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE RESTRICT, status text NOT NULL, attempt_number integer NOT NULL,
      provider_key text NOT NULL, provider_settlement_id text, retry_policy_version_id uuid REFERENCES retry_policy_versions(id) ON DELETE RESTRICT,
      next_retry_at timestamptz, failure_code text, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('PENDING','SUCCEEDED','FAILED','RETRY_PENDING','RECONCILIATION_REQUIRED')), CHECK (attempt_number > 0), UNIQUE (settlement_id, attempt_number), UNIQUE (provider_key, provider_settlement_id)
    );
    CREATE TABLE provider_references (
      id uuid PRIMARY KEY, provider_key text NOT NULL, reference_type text NOT NULL, provider_reference text NOT NULL,
      internal_entity_type text NOT NULL, internal_entity_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (reference_type IN ('ORDER','PAYMENT','REFUND','SETTLEMENT','EVENT','OTHER_APPROVED')), UNIQUE (provider_key, reference_type, provider_reference)
    );

    CREATE TABLE provider_webhook_events (
      id uuid PRIMARY KEY, provider_key text NOT NULL, provider_event_id text NOT NULL, event_type text NOT NULL, provider_schema_version text,
      handler_version text NOT NULL, status text NOT NULL, payload jsonb NOT NULL, payload_raw text NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT current_timestamp, authenticated_at timestamptz, persisted_at timestamptz, processing_started_at timestamptz,
      processed_at timestamptz, next_retry_at timestamptz, retry_count integer NOT NULL DEFAULT 0, reconciliation_required_at timestamptz,
      CHECK (status IN ('RECEIVED','AUTHENTICATED','PERSISTED','PROCESSING','PROCESSED','RETRY_PENDING','RECONCILIATION_REQUIRED','UNKNOWN')),
      CHECK (retry_count >= 0), CHECK (jsonb_typeof(payload) = 'object'), UNIQUE (provider_key, provider_event_id)
    );
    CREATE TABLE reconciliation_records (
      id uuid PRIMARY KEY, status text NOT NULL, provider_key text NOT NULL, provider_webhook_event_id uuid REFERENCES provider_webhook_events(id) ON DELETE RESTRICT,
      internal_entity_type text NOT NULL, internal_entity_id uuid, match_data jsonb NOT NULL DEFAULT '{}'::jsonb, discrepancy_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, resolved_at timestamptz, resolved_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      CHECK (status IN ('PENDING','MATCHED','MISMATCH','AMBIGUOUS','MANUAL_REVIEW','RESOLVED')), CHECK (jsonb_typeof(match_data) = 'object'), CHECK (jsonb_typeof(discrepancy_data) = 'object')
    );

    CREATE TABLE financial_adjustments (
      id uuid PRIMARY KEY, allocation_snapshot_id uuid NOT NULL REFERENCES financial_allocation_snapshots(id) ON DELETE RESTRICT,
      status text NOT NULL, category text NOT NULL, affected_component_type text NOT NULL, currency char(3) NOT NULL, amount_minor bigint NOT NULL,
      reason text NOT NULL, reference_context text NOT NULL, requested_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      executed_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp, executed_at timestamptz,
      CHECK (status IN ('REQUESTED','APPROVED','REJECTED','EXECUTED','RECONCILIATION_REQUIRED')),
      CHECK (category IN ('REFUND_CORRECTION','SETTLEMENT_CORRECTION','FEE_CORRECTION','TAX_CORRECTION','OTHER_APPROVED')),
      CHECK (affected_component_type IN ('DISCOUNT','TAX','PROCESSING_FEE','PLATFORM_COMMISSION','PROVIDER_PAYABLE','OTHER_APPROVED_CHARGE')),
      CHECK (currency ~ '^[A-Z]{3}$'), CHECK (amount_minor <> 0), CHECK (char_length(reason) > 0), CHECK (char_length(reference_context) > 0)
    );
    CREATE TABLE financial_adjustment_approvals (
      id uuid PRIMARY KEY, financial_adjustment_id uuid NOT NULL REFERENCES financial_adjustments(id) ON DELETE RESTRICT,
      decision text NOT NULL, approver_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, reason text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, CHECK (decision IN ('APPROVED','REJECTED')), UNIQUE (financial_adjustment_id, approver_account_id)
    );
    CREATE TABLE ledger_accounts (
      id uuid PRIMARY KEY, account_code text NOT NULL UNIQUE, account_type text NOT NULL, currency char(3) NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE','EQUITY')), CHECK (status IN ('ACTIVE','ARCHIVED')), CHECK (currency ~ '^[A-Z]{3}$')
    );
    CREATE TABLE ledger_transactions (
      id uuid PRIMARY KEY, status text NOT NULL, currency char(3) NOT NULL, reference_type text NOT NULL, reference_id uuid, description text NOT NULL,
      posted_at timestamptz, created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('DRAFT','POSTED','REVERSED')), CHECK (currency ~ '^[A-Z]{3}$'), CHECK (char_length(description) > 0)
    );
    CREATE TABLE ledger_entries (
      id uuid PRIMARY KEY, ledger_transaction_id uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
      ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT, direction text NOT NULL, amount_minor bigint NOT NULL, currency char(3) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, CHECK (direction IN ('DEBIT','CREDIT')), CHECK (amount_minor > 0), CHECK (currency ~ '^[A-Z]{3}$')
    );
    CREATE INDEX ledger_entries_transaction ON ledger_entries(ledger_transaction_id);
    CREATE TABLE legal_holds (
      id uuid PRIMARY KEY, record_category text NOT NULL, subject_type text NOT NULL, subject_id uuid NOT NULL, status text NOT NULL,
      reason text NOT NULL, created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT, released_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp, released_at timestamptz,
      CHECK (record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK')), CHECK (status IN ('ACTIVE','RELEASED')), CHECK (char_length(reason) > 0)
    );
    CREATE INDEX legal_holds_active_subject ON legal_holds(record_category, subject_type, subject_id) WHERE status = 'ACTIVE';

    CREATE FUNCTION financial_immutable_guard() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'financial immutable record cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER financial_allocation_snapshots_immutable BEFORE UPDATE OR DELETE ON financial_allocation_snapshots FOR EACH ROW EXECUTE FUNCTION financial_immutable_guard();
    CREATE FUNCTION provider_webhook_event_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'provider webhook event cannot be deleted'; END IF;
      IF NEW.provider_key <> OLD.provider_key OR NEW.provider_event_id <> OLD.provider_event_id OR NEW.event_type <> OLD.event_type OR NEW.payload <> OLD.payload OR NEW.payload_raw <> OLD.payload_raw OR NEW.payload_hash <> OLD.payload_hash OR NEW.handler_version <> OLD.handler_version THEN
        RAISE EXCEPTION 'provider webhook fact cannot be changed';
      END IF;
      IF NEW.status <> OLD.status AND NOT ((OLD.status = 'PERSISTED' AND NEW.status = 'PROCESSING') OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSED','RETRY_PENDING','RECONCILIATION_REQUIRED')) OR (OLD.status = 'RETRY_PENDING' AND NEW.status = 'PROCESSING')) THEN
        RAISE EXCEPTION 'invalid provider webhook state transition';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER provider_webhook_events_immutable BEFORE UPDATE OR DELETE ON provider_webhook_events FOR EACH ROW EXECUTE FUNCTION provider_webhook_event_guard();
    CREATE FUNCTION ledger_posted_immutable_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'ledger_transactions' AND OLD.status IN ('POSTED','REVERSED') THEN
        RAISE EXCEPTION 'posted ledger records cannot be changed';
      END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION ledger_posted_immutable_guard();
    CREATE FUNCTION ledger_entry_immutable_guard() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ledger_transactions WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.ledger_transaction_id ELSE NEW.ledger_transaction_id END AND status IN ('POSTED','REVERSED')) THEN
        RAISE EXCEPTION 'posted ledger records cannot be changed';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER ledger_entries_immutable BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable_guard();
    CREATE FUNCTION ledger_balance_guard() RETURNS trigger AS $$
    DECLARE transaction_id uuid; debit_total bigint; credit_total bigint;
    BEGIN
      transaction_id := COALESCE(NEW.id, OLD.id);
      IF (SELECT status FROM ledger_transactions WHERE id = transaction_id) = 'POSTED' THEN
        SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END),0), COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END),0) INTO debit_total, credit_total FROM ledger_entries WHERE ledger_transaction_id = transaction_id;
        IF debit_total <> credit_total THEN RAISE EXCEPTION 'posted ledger transaction must balance'; END IF;
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER ledger_transaction_balance AFTER INSERT OR UPDATE OF status ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balance_guard();
    CREATE FUNCTION financial_adjustment_approval_guard() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM financial_adjustments WHERE id = NEW.financial_adjustment_id AND requested_by_account_id = NEW.approver_account_id) THEN
        RAISE EXCEPTION 'financial adjustment requester cannot approve own adjustment';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER financial_adjustment_approval_separation BEFORE INSERT ON financial_adjustment_approvals FOR EACH ROW EXECUTE FUNCTION financial_adjustment_approval_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER financial_adjustment_approval_separation ON financial_adjustment_approvals; DROP FUNCTION financial_adjustment_approval_guard();
    DROP TRIGGER ledger_transaction_balance ON ledger_transactions;
    DROP FUNCTION ledger_balance_guard(); DROP TRIGGER ledger_entries_immutable ON ledger_entries; DROP FUNCTION ledger_entry_immutable_guard(); DROP TRIGGER ledger_transactions_immutable ON ledger_transactions; DROP FUNCTION ledger_posted_immutable_guard();
    DROP TRIGGER provider_webhook_events_immutable ON provider_webhook_events; DROP FUNCTION provider_webhook_event_guard(); DROP TRIGGER financial_allocation_snapshots_immutable ON financial_allocation_snapshots; DROP FUNCTION financial_immutable_guard();
    DROP TABLE legal_holds; DROP TABLE ledger_entries; DROP TABLE ledger_transactions; DROP TABLE ledger_accounts; DROP TABLE financial_adjustment_approvals; DROP TABLE financial_adjustments;
    DROP TABLE reconciliation_records; DROP TABLE provider_webhook_events; DROP TABLE provider_references; DROP TABLE settlement_attempts; DROP TABLE settlements; DROP TABLE refunds; DROP TABLE payments; DROP TABLE payment_intents;
    DROP TABLE financial_allocation_components; DROP TABLE financial_allocation_snapshots; DROP TABLE retention_policy_versions; DROP TABLE retry_policy_versions; DROP TABLE settlement_policy_versions; DROP TABLE refund_policy_versions;
    DROP TABLE commercial_rule_scopes; DROP TABLE commercial_rule_versions; DROP TABLE commercial_rules;
  `);
};

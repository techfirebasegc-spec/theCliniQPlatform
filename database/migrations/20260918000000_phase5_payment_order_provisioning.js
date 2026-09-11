exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE payment_order_provisioning_attempts (
      id uuid PRIMARY KEY,
      payment_intent_id uuid NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE RESTRICT,
      provider_key text NOT NULL,
      provider_receipt text NOT NULL,
      status text NOT NULL,
      claim_token uuid,
      lease_expires_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      reconciliation_details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      finalized_at timestamptz,
      CHECK (status IN ('READY','CLAIMED','FINALIZED','RECONCILIATION_REQUIRED')),
      CHECK (attempt_count >= 0),
      CHECK (jsonb_typeof(reconciliation_details) = 'object'),
      CHECK (
        (status = 'CLAIMED' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finalized_at IS NULL)
        OR (status = 'READY' AND claim_token IS NULL AND lease_expires_at IS NULL AND finalized_at IS NULL)
        OR (status = 'FINALIZED' AND claim_token IS NULL AND lease_expires_at IS NULL AND finalized_at IS NOT NULL)
        OR (status = 'RECONCILIATION_REQUIRED' AND claim_token IS NULL AND lease_expires_at IS NULL)
      ),
      UNIQUE (provider_key, provider_receipt)
    );
    CREATE INDEX payment_order_provisioning_attempts_claimable
      ON payment_order_provisioning_attempts(status, lease_expires_at)
      WHERE status = 'CLAIMED';

    ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_pending_provider_order_check
      CHECK (status <> 'PENDING_PROVIDER' OR provider_order_id IS NOT NULL);

    CREATE FUNCTION payment_intent_provider_order_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'PENDING_PROVIDER' AND NEW.provider_order_id IS NULL THEN
          RAISE EXCEPTION 'pending provider payment intent requires provider order';
        END IF;
        IF NEW.status = 'PENDING_PROVIDER' AND NOT EXISTS (
          SELECT 1 FROM provider_references reference
          WHERE reference.provider_key=NEW.provider_key AND reference.reference_type='ORDER'
            AND reference.provider_reference=NEW.provider_order_id
            AND reference.internal_entity_type='PAYMENT_INTENT' AND reference.internal_entity_id=NEW.id
        ) THEN RAISE EXCEPTION 'pending provider payment intent requires provider order reference'; END IF;
        RETURN NEW;
      END IF;

      IF OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
        RAISE EXCEPTION 'provider order relationship cannot be replaced';
      END IF;
      IF OLD.provider_order_id IS NULL AND NEW.provider_order_id IS NOT NULL
        AND NOT (OLD.status = 'CREATED' AND NEW.status = 'PENDING_PROVIDER') THEN
        RAISE EXCEPTION 'provider order relationship must be finalized with pending provider transition';
      END IF;
      IF NEW.status = 'PENDING_PROVIDER' AND NEW.provider_order_id IS NULL THEN
        RAISE EXCEPTION 'pending provider payment intent requires provider order';
      END IF;
      IF NEW.status = 'PENDING_PROVIDER' AND NOT EXISTS (
        SELECT 1 FROM provider_references reference
        WHERE reference.provider_key=NEW.provider_key AND reference.reference_type='ORDER'
          AND reference.provider_reference=NEW.provider_order_id
          AND reference.internal_entity_type='PAYMENT_INTENT' AND reference.internal_entity_id=NEW.id
      ) THEN RAISE EXCEPTION 'pending provider payment intent requires provider order reference'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER payment_intents_provider_order_integrity
      BEFORE INSERT OR UPDATE ON payment_intents
      FOR EACH ROW EXECUTE FUNCTION payment_intent_provider_order_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM payment_order_provisioning_attempts) THEN
        RAISE EXCEPTION 'cannot roll back payment order provisioning while attempts exist';
      END IF;
      IF EXISTS (SELECT 1 FROM payment_intents WHERE provider_order_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot roll back payment order provisioning while provider order relationships exist';
      END IF;
    END $$;
    DROP TRIGGER payment_intents_provider_order_integrity ON payment_intents;
    DROP FUNCTION payment_intent_provider_order_guard();
    ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_pending_provider_order_check;
    DROP INDEX payment_order_provisioning_attempts_claimable;
    DROP TABLE payment_order_provisioning_attempts;
  `);
};

/* theCliniQ Phase 6.3A: provider-neutral external payment-account foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE provider_payment_accounts (
      id uuid PRIMARY KEY,
      provider_kind text NOT NULL,
      doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      payment_provider text NOT NULL,
      external_account_reference text NOT NULL,
      status text NOT NULL,
      verification_status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (provider_kind IN ('DOCTOR','CLINIC')),
      CHECK ((provider_kind='DOCTOR' AND doctor_profile_id IS NOT NULL AND clinic_id IS NULL) OR (provider_kind='CLINIC' AND clinic_id IS NOT NULL AND doctor_profile_id IS NULL)),
      CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','DISABLED')),
      CHECK (verification_status IN ('NOT_SUBMITTED','PENDING','VERIFIED','REJECTED')),
      CHECK (char_length(btrim(payment_provider)) > 0),
      CHECK (char_length(btrim(external_account_reference)) > 0),
      UNIQUE (payment_provider, external_account_reference)
    );
    CREATE UNIQUE INDEX provider_payment_accounts_active_doctor_provider_unique
      ON provider_payment_accounts(doctor_profile_id,payment_provider)
      WHERE status='ACTIVE' AND doctor_profile_id IS NOT NULL;
    CREATE UNIQUE INDEX provider_payment_accounts_active_clinic_provider_unique
      ON provider_payment_accounts(clinic_id,payment_provider)
      WHERE status='ACTIVE' AND clinic_id IS NOT NULL;

    CREATE FUNCTION provider_payment_account_identity_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.provider_kind,OLD.doctor_profile_id,OLD.clinic_id,OLD.payment_provider,OLD.external_account_reference,OLD.created_at)
        IS DISTINCT FROM (NEW.provider_kind,NEW.doctor_profile_id,NEW.clinic_id,NEW.payment_provider,NEW.external_account_reference,NEW.created_at) THEN
        RAISE EXCEPTION 'provider payment account identity cannot be changed';
      END IF;
      NEW.updated_at = current_timestamp;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER provider_payment_accounts_identity_immutable
      BEFORE UPDATE ON provider_payment_accounts FOR EACH ROW EXECUTE FUNCTION provider_payment_account_identity_guard();

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM settlements) THEN
        RAISE EXCEPTION 'cannot migrate settlements to provider payment accounts while settlement history exists';
      END IF;
    END $$;
    ALTER TABLE settlements ADD COLUMN provider_payment_account_id uuid NOT NULL REFERENCES provider_payment_accounts(id) ON DELETE RESTRICT;
    ALTER TABLE settlements DROP COLUMN provider_account_id;
    ALTER TABLE settlements ADD CONSTRAINT settlements_provider_payment_account_idempotency_unique UNIQUE (provider_payment_account_id,idempotency_key);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM settlements) OR EXISTS (SELECT 1 FROM provider_payment_accounts) THEN
        RAISE EXCEPTION 'cannot roll back Phase 6.3A while provider payment account or settlement evidence exists';
      END IF;
    END $$;
    ALTER TABLE settlements DROP CONSTRAINT settlements_provider_payment_account_idempotency_unique;
    ALTER TABLE settlements ADD COLUMN provider_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT;
    ALTER TABLE settlements DROP COLUMN provider_payment_account_id;
    ALTER TABLE settlements ADD CONSTRAINT settlements_provider_account_idempotency_key UNIQUE (provider_account_id,idempotency_key);
    DROP TRIGGER provider_payment_accounts_identity_immutable ON provider_payment_accounts;
    DROP FUNCTION provider_payment_account_identity_guard();
    DROP INDEX provider_payment_accounts_active_clinic_provider_unique;
    DROP INDEX provider_payment_accounts_active_doctor_provider_unique;
    DROP TABLE provider_payment_accounts;
  `);
};

/* theCliniQ Phase 5 Step 1: Service Offering and versioned provider pricing foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    CREATE TABLE service_offerings (
      id uuid PRIMARY KEY,
      owner_doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      owner_clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      name text NOT NULL,
      description text,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      updated_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK ((owner_doctor_profile_id IS NOT NULL AND owner_clinic_id IS NULL) OR (owner_doctor_profile_id IS NULL AND owner_clinic_id IS NOT NULL)),
      CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
      CHECK (char_length(btrim(name)) > 0)
    );
    CREATE INDEX service_offerings_owner_doctor ON service_offerings(owner_doctor_profile_id);
    CREATE INDEX service_offerings_owner_clinic ON service_offerings(owner_clinic_id);
    CREATE INDEX service_offerings_status ON service_offerings(status);

    CREATE TABLE service_offering_versions (
      id uuid PRIMARY KEY,
      service_offering_id uuid NOT NULL REFERENCES service_offerings(id) ON DELETE RESTRICT,
      version_number integer NOT NULL,
      status text NOT NULL,
      effective_from timestamptz NOT NULL,
      effective_to timestamptz,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (version_number > 0),
      CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
      CHECK (effective_to IS NULL OR effective_to > effective_from),
      UNIQUE (service_offering_id, version_number),
      CONSTRAINT service_offering_versions_effective_range_excl EXCLUDE USING gist (service_offering_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
    );
    CREATE INDEX service_offering_versions_selection ON service_offering_versions(service_offering_id, status, effective_from);

    CREATE TABLE service_offering_prices (
      id uuid PRIMARY KEY,
      service_offering_version_id uuid NOT NULL UNIQUE REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      currency char(3) NOT NULL,
      amount_minor bigint NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (currency ~ '^[A-Z]{3}$'),
      CHECK (amount_minor >= 0)
    );

    CREATE FUNCTION service_offering_version_immutable_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'service offering versions are immutable';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER service_offering_versions_immutable BEFORE UPDATE OR DELETE ON service_offering_versions FOR EACH ROW EXECUTE FUNCTION service_offering_version_immutable_guard();
    CREATE FUNCTION service_offering_price_immutable_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'service offering prices are immutable';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER service_offering_prices_immutable BEFORE UPDATE OR DELETE ON service_offering_prices FOR EACH ROW EXECUTE FUNCTION service_offering_price_immutable_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER service_offering_prices_immutable ON service_offering_prices;
    DROP FUNCTION service_offering_price_immutable_guard();
    DROP TRIGGER service_offering_versions_immutable ON service_offering_versions;
    DROP FUNCTION service_offering_version_immutable_guard();
    DROP TABLE service_offering_prices;
    DROP TABLE service_offering_versions;
    DROP TABLE service_offerings;
  `);
};

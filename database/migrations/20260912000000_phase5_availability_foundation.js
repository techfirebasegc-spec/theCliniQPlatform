/* theCliniQ Phase 5 Step 2: configuration-only Availability Foundation. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE availability_configurations (
      id uuid PRIMARY KEY,
      service_offering_version_id uuid NOT NULL UNIQUE REFERENCES service_offering_versions(id) ON DELETE RESTRICT,
      provider_timezone text NOT NULL,
      slot_duration_seconds integer NOT NULL,
      buffer_before_seconds integer NOT NULL,
      buffer_after_seconds integer NOT NULL,
      capacity integer NOT NULL,
      booking_lead_time_seconds integer NOT NULL,
      booking_horizon_seconds integer NOT NULL,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (char_length(btrim(provider_timezone)) > 0),
      CHECK (slot_duration_seconds > 0), CHECK (buffer_before_seconds >= 0), CHECK (buffer_after_seconds >= 0),
      CHECK (capacity > 0), CHECK (booking_lead_time_seconds >= 0),
      CHECK (booking_horizon_seconds > booking_lead_time_seconds),
      CHECK (status IN ('ACTIVE','INACTIVE'))
    );
    CREATE TABLE availability_rules (
      id uuid PRIMARY KEY,
      availability_configuration_id uuid NOT NULL REFERENCES availability_configurations(id) ON DELETE RESTRICT,
      canonical_recurrence text NOT NULL,
      recurrence_identity text NOT NULL,
      effective_from timestamptz NOT NULL,
      effective_to timestamptz,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (canonical_recurrence = recurrence_identity),
      CHECK (canonical_recurrence ~ '^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*$'),
      CHECK (effective_to IS NULL OR effective_to > effective_from),
      CHECK (status IN ('ACTIVE','INACTIVE')),
      CONSTRAINT availability_rules_effective_identity_excl EXCLUDE USING gist (
        availability_configuration_id WITH =, recurrence_identity WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&)
    );
    CREATE TABLE availability_windows (
      id uuid PRIMARY KEY,
      availability_rule_id uuid NOT NULL REFERENCES availability_rules(id) ON DELETE RESTRICT,
      kind text NOT NULL,
      weekday smallint NOT NULL,
      start_seconds integer NOT NULL,
      end_seconds integer NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (kind IN ('WORKING','BREAK')), CHECK (weekday BETWEEN 1 AND 7),
      CHECK (start_seconds >= 0 AND end_seconds <= 86400 AND start_seconds < end_seconds),
      UNIQUE (availability_rule_id, kind, weekday, start_seconds, end_seconds)
    );
    CREATE TABLE availability_exceptions (
      id uuid PRIMARY KEY,
      availability_configuration_id uuid NOT NULL REFERENCES availability_configurations(id) ON DELETE RESTRICT,
      kind text NOT NULL,
      local_start timestamp NOT NULL,
      local_end timestamp NOT NULL,
      derived_start_utc timestamptz NOT NULL,
      derived_end_utc timestamptz NOT NULL,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (kind IN ('HOLIDAY','LEAVE','BLOCKED','ONE_OFF')),
      CHECK (local_end > local_start), CHECK (derived_end_utc > derived_start_utc),
      CHECK (status IN ('ACTIVE','INACTIVE')),
      UNIQUE (availability_configuration_id, kind, local_start, local_end)
    );
    CREATE INDEX availability_rules_configuration_effective ON availability_rules(availability_configuration_id, effective_from);
    CREATE INDEX availability_windows_rule_day ON availability_windows(availability_rule_id, weekday, kind, start_seconds);
    CREATE INDEX availability_exceptions_configuration_utc ON availability_exceptions(availability_configuration_id, derived_start_utc);

    CREATE FUNCTION availability_derive_utc(timezone_name text, local_value timestamp) RETURNS timestamptz AS $$
      SELECT min(candidate)
      FROM generate_series((local_value AT TIME ZONE timezone_name) - interval '3 hours', (local_value AT TIME ZONE timezone_name) + interval '3 hours', interval '1 minute') candidate
      WHERE candidate AT TIME ZONE timezone_name = local_value;
    $$ LANGUAGE sql STABLE;
    CREATE FUNCTION availability_exception_derived_guard() RETURNS trigger AS $$
    DECLARE timezone_name text; start_value timestamptz; end_value timestamptz;
    BEGIN
      SELECT provider_timezone INTO timezone_name FROM availability_configurations WHERE id = NEW.availability_configuration_id;
      start_value := availability_derive_utc(timezone_name, NEW.local_start);
      end_value := availability_derive_utc(timezone_name, NEW.local_end);
      IF start_value IS NULL OR end_value IS NULL THEN RAISE EXCEPTION 'availability exception local time does not exist'; END IF;
      NEW.derived_start_utc := start_value; NEW.derived_end_utc := end_value;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER availability_exception_derived BEFORE INSERT OR UPDATE ON availability_exceptions FOR EACH ROW EXECUTE FUNCTION availability_exception_derived_guard();
    CREATE FUNCTION availability_window_integrity_guard() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM availability_windows w WHERE w.availability_rule_id = NEW.availability_rule_id AND w.kind = NEW.kind AND w.weekday = NEW.weekday AND w.id <> NEW.id AND w.start_seconds < NEW.end_seconds AND NEW.start_seconds < w.end_seconds) THEN RAISE EXCEPTION 'availability windows overlap'; END IF;
      IF NEW.kind = 'BREAK' AND NOT EXISTS (SELECT 1 FROM availability_windows w WHERE w.availability_rule_id = NEW.availability_rule_id AND w.kind = 'WORKING' AND w.weekday = NEW.weekday AND w.start_seconds <= NEW.start_seconds AND w.end_seconds >= NEW.end_seconds) THEN RAISE EXCEPTION 'availability break must be contained in working availability'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER availability_window_integrity BEFORE INSERT OR UPDATE ON availability_windows FOR EACH ROW EXECUTE FUNCTION availability_window_integrity_guard();
    CREATE FUNCTION availability_exception_conflict_guard() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM availability_exceptions e WHERE e.availability_configuration_id = NEW.availability_configuration_id AND e.kind = NEW.kind AND e.status = 'ACTIVE' AND NEW.status = 'ACTIVE' AND e.id <> NEW.id AND e.derived_start_utc < NEW.derived_end_utc AND NEW.derived_start_utc < e.derived_end_utc) THEN RAISE EXCEPTION 'availability exceptions conflict'; END IF;
      IF NEW.kind = 'ONE_OFF' AND NEW.local_start <= current_timestamp AT TIME ZONE (SELECT provider_timezone FROM availability_configurations WHERE id=NEW.availability_configuration_id) THEN RAISE EXCEPTION 'availability one-off must be future'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER z_availability_exception_conflict BEFORE INSERT OR UPDATE ON availability_exceptions FOR EACH ROW EXECUTE FUNCTION availability_exception_conflict_guard();
  `);
};
exports.down = (pgm) => pgm.sql(`
  DROP TRIGGER z_availability_exception_conflict ON availability_exceptions;
  DROP FUNCTION availability_exception_conflict_guard();
  DROP TRIGGER availability_window_integrity ON availability_windows;
  DROP FUNCTION availability_window_integrity_guard();
  DROP TRIGGER availability_exception_derived ON availability_exceptions;
  DROP FUNCTION availability_exception_derived_guard();
  DROP FUNCTION availability_derive_utc(text, timestamp);
  DROP TABLE availability_exceptions;
  DROP TABLE availability_windows;
  DROP TABLE availability_rules;
  DROP TABLE availability_configurations;
`);

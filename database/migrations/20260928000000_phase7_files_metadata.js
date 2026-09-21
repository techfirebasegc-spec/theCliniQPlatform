/* theCliniQ Phase 7.1C: provider-neutral private object metadata. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      storage_provider text NOT NULL,
      bucket text NOT NULL,
      object_key text NOT NULL UNIQUE,
      original_filename text NOT NULL,
      content_type text NOT NULL,
      byte_size bigint NOT NULL,
      sha256 text,
      status text NOT NULL,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      create_idempotency_key text NOT NULL,
      create_request_fingerprint text NOT NULL,
      deleted_at timestamptz,
      deleted_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      CHECK (storage_provider='AIC_S3'),
      CHECK (char_length(btrim(bucket)) > 0),
      CHECK (char_length(btrim(object_key)) > 0),
      CHECK (char_length(btrim(original_filename)) > 0 AND original_filename !~ E'[\\r\\n]'),
      CHECK (char_length(btrim(content_type)) > 0 AND content_type !~ E'[\\r\\n]'),
      CHECK (byte_size > 0),
      CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
      CHECK (status IN ('PENDING_UPLOAD','AVAILABLE','UPLOAD_FAILED','DELETE_PENDING','DELETED','RECONCILIATION_REQUIRED')),
      CHECK (status <> 'AVAILABLE' OR sha256 IS NOT NULL),
      CHECK ((status='DELETED' AND deleted_at IS NOT NULL AND deleted_by_account_id IS NOT NULL) OR (status <> 'DELETED' AND deleted_at IS NULL AND deleted_by_account_id IS NULL)),
      CHECK (char_length(btrim(create_idempotency_key)) > 0),
      CHECK (char_length(btrim(create_request_fingerprint)) > 0),
      UNIQUE (created_by_account_id, create_idempotency_key)
    );
    CREATE INDEX files_status_created_at ON files(status,created_at DESC);
    CREATE INDEX files_created_at ON files(created_at DESC);

    CREATE TABLE file_bindings (
      id uuid PRIMARY KEY,
      file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
      purpose text NOT NULL,
      conversation_id uuid REFERENCES conversations(id) ON DELETE RESTRICT,
      prescription_id uuid REFERENCES prescriptions(id) ON DELETE RESTRICT,
      patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      doctor_profile_id uuid REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      clinic_id uuid REFERENCES clinics(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (
        (purpose='CHAT_ATTACHMENT' AND conversation_id IS NOT NULL AND prescription_id IS NULL AND patient_profile_id IS NULL AND doctor_profile_id IS NULL AND clinic_id IS NULL)
        OR (purpose='PRESCRIPTION_DOCUMENT' AND prescription_id IS NOT NULL AND conversation_id IS NULL AND patient_profile_id IS NULL AND doctor_profile_id IS NULL AND clinic_id IS NULL)
        OR (purpose='PATIENT_PROFILE_MEDIA' AND patient_profile_id IS NOT NULL AND conversation_id IS NULL AND prescription_id IS NULL AND doctor_profile_id IS NULL AND clinic_id IS NULL)
        OR (purpose='DOCTOR_PROFILE_MEDIA' AND doctor_profile_id IS NOT NULL AND conversation_id IS NULL AND prescription_id IS NULL AND patient_profile_id IS NULL AND clinic_id IS NULL)
        OR (purpose='CLINIC_DOCUMENT' AND clinic_id IS NOT NULL AND conversation_id IS NULL AND prescription_id IS NULL AND patient_profile_id IS NULL AND doctor_profile_id IS NULL)
      )
    );
    CREATE INDEX file_bindings_conversation ON file_bindings(conversation_id) WHERE conversation_id IS NOT NULL;
    CREATE INDEX file_bindings_prescription ON file_bindings(prescription_id) WHERE prescription_id IS NOT NULL;
    CREATE INDEX file_bindings_patient_profile ON file_bindings(patient_profile_id) WHERE patient_profile_id IS NOT NULL;
    CREATE INDEX file_bindings_doctor_profile ON file_bindings(doctor_profile_id) WHERE doctor_profile_id IS NOT NULL;
    CREATE INDEX file_bindings_clinic ON file_bindings(clinic_id) WHERE clinic_id IS NOT NULL;

    CREATE FUNCTION file_metadata_mutation_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'file metadata cannot be deleted';
      END IF;
      IF TG_OP='INSERT' AND NEW.status <> 'PENDING_UPLOAD' THEN
        RAISE EXCEPTION 'file metadata must be created pending upload';
      END IF;
      IF TG_OP='UPDATE' THEN
        IF (OLD.id,OLD.storage_provider,OLD.bucket,OLD.object_key,OLD.original_filename,OLD.content_type,OLD.byte_size,OLD.created_by_account_id,OLD.created_at,OLD.create_idempotency_key,OLD.create_request_fingerprint)
          IS DISTINCT FROM (NEW.id,NEW.storage_provider,NEW.bucket,NEW.object_key,NEW.original_filename,NEW.content_type,NEW.byte_size,NEW.created_by_account_id,NEW.created_at,NEW.create_idempotency_key,NEW.create_request_fingerprint) THEN
          RAISE EXCEPTION 'file storage identity cannot be changed';
        END IF;
        IF OLD.status='DELETED' THEN
          RAISE EXCEPTION 'deleted file metadata cannot be changed';
        END IF;
        IF OLD.status <> NEW.status AND NOT (
          (OLD.status='PENDING_UPLOAD' AND NEW.status IN ('AVAILABLE','UPLOAD_FAILED','RECONCILIATION_REQUIRED'))
          OR (OLD.status='UPLOAD_FAILED' AND NEW.status='PENDING_UPLOAD')
          OR (OLD.status='RECONCILIATION_REQUIRED' AND NEW.status IN ('AVAILABLE','UPLOAD_FAILED','DELETED'))
          OR (OLD.status='AVAILABLE' AND NEW.status IN ('DELETE_PENDING','RECONCILIATION_REQUIRED'))
          OR (OLD.status='DELETE_PENDING' AND NEW.status IN ('DELETED','RECONCILIATION_REQUIRED'))
        ) THEN
          RAISE EXCEPTION 'file metadata status transition is invalid';
        END IF;
        IF NEW.status='DELETED' AND OLD.status <> 'DELETED' THEN
          IF NEW.deleted_by_account_id IS NULL THEN
            RAISE EXCEPTION 'deleted file metadata requires deleting account';
          END IF;
          NEW.deleted_at=current_timestamp;
        ELSIF NEW.status <> 'DELETED' THEN
          NEW.deleted_at=NULL;
          NEW.deleted_by_account_id=NULL;
        END IF;
        NEW.updated_at=current_timestamp;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER files_metadata_integrity
      BEFORE INSERT OR UPDATE OR DELETE ON files
      FOR EACH ROW EXECUTE FUNCTION file_metadata_mutation_guard();

    CREATE FUNCTION file_binding_immutable_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP IN ('UPDATE','DELETE') THEN
        RAISE EXCEPTION 'file binding cannot be changed';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER file_bindings_immutable
      BEFORE UPDATE OR DELETE ON file_bindings
      FOR EACH ROW EXECUTE FUNCTION file_binding_immutable_guard();

    CREATE FUNCTION file_metadata_binding_guard() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM file_bindings WHERE file_id=NEW.id) THEN
        RAISE EXCEPTION 'file metadata requires exactly one binding';
      END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER files_require_one_binding
      AFTER INSERT ON files DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION file_metadata_binding_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM file_bindings) OR EXISTS (SELECT 1 FROM files) THEN
        RAISE EXCEPTION 'cannot roll back files metadata while file evidence exists';
      END IF;
    END $$;
    DROP TRIGGER files_require_one_binding ON files;
    DROP FUNCTION file_metadata_binding_guard();
    DROP TRIGGER file_bindings_immutable ON file_bindings;
    DROP FUNCTION file_binding_immutable_guard();
    DROP TRIGGER files_metadata_integrity ON files;
    DROP FUNCTION file_metadata_mutation_guard();
    DROP TABLE file_bindings;
    DROP TABLE files;
  `);
};

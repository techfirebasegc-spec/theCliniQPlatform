/* Professional-verification evidence and review lifecycle for existing doctor profiles. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE doctor_verification_submissions (
      id uuid PRIMARY KEY,
      doctor_profile_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      registration_authority text NOT NULL,
      registration_jurisdiction text NOT NULL,
      registration_identifier text NOT NULL,
      status text NOT NULL,
      submitted_at timestamptz NOT NULL DEFAULT current_timestamp,
      reviewed_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      reviewed_at timestamptz,
      rejection_reason text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      updated_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      CHECK (char_length(btrim(registration_authority)) > 0),
      CHECK (char_length(btrim(registration_jurisdiction)) > 0),
      CHECK (char_length(btrim(registration_identifier)) > 0),
      CHECK (
        (status='PENDING' AND reviewed_by_account_id IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL)
        OR (status='APPROVED' AND reviewed_by_account_id IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NULL)
        OR (status='REJECTED' AND reviewed_by_account_id IS NOT NULL AND reviewed_at IS NOT NULL AND char_length(btrim(rejection_reason)) > 0)
      )
    );
    CREATE UNIQUE INDEX doctor_verification_submissions_one_pending
      ON doctor_verification_submissions(doctor_profile_id) WHERE status='PENDING';
    CREATE INDEX doctor_verification_submissions_profile_created
      ON doctor_verification_submissions(doctor_profile_id, created_at DESC);
    CREATE INDEX doctor_verification_submissions_status_submitted
      ON doctor_verification_submissions(status, submitted_at DESC);

    CREATE TABLE doctor_verification_submission_documents (
      id uuid PRIMARY KEY,
      submission_id uuid NOT NULL REFERENCES doctor_verification_submissions(id) ON DELETE RESTRICT,
      file_id uuid NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      UNIQUE (submission_id, file_id)
    );
    CREATE INDEX doctor_verification_submission_documents_submission
      ON doctor_verification_submission_documents(submission_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE doctor_verification_submission_documents;
    DROP TABLE doctor_verification_submissions;
  `);
};

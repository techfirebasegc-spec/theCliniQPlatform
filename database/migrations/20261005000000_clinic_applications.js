/* Public clinic applications, reviewed before existing owner onboarding begins. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE clinic_applications (
      id uuid PRIMARY KEY,
      applicant_account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
      legal_name text NOT NULL,
      clinic_name text NOT NULL,
      owner_email text NOT NULL,
      status text NOT NULL,
      submitted_at timestamptz NOT NULL DEFAULT current_timestamp,
      reviewer_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      reviewed_at timestamptz,
      rejection_reason text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      CHECK (char_length(btrim(legal_name)) > 0),
      CHECK (char_length(btrim(clinic_name)) > 0),
      CHECK (char_length(btrim(owner_email)) > 0),
      CHECK (
        (status = 'PENDING' AND reviewer_account_id IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL)
        OR (status = 'APPROVED' AND reviewer_account_id IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NULL)
        OR (status = 'REJECTED' AND reviewer_account_id IS NOT NULL AND reviewed_at IS NOT NULL AND char_length(btrim(rejection_reason)) > 0)
      )
    );
    CREATE INDEX clinic_applications_pending_submitted
      ON clinic_applications(status, submitted_at ASC) WHERE status = 'PENDING';
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE clinic_applications;');
};

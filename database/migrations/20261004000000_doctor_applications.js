/* Independent doctor application review lifecycle for existing doctor profiles. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE doctor_applications (
      id uuid PRIMARY KEY,
      doctor_profile_id uuid NOT NULL UNIQUE REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      status text NOT NULL,
      submitted_at timestamptz NOT NULL DEFAULT current_timestamp,
      reviewed_at timestamptz,
      reviewer_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
      rejection_reason text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      CHECK (
        (status = 'PENDING' AND reviewed_at IS NULL AND reviewer_account_id IS NULL AND rejection_reason IS NULL)
        OR (status = 'APPROVED' AND reviewed_at IS NOT NULL AND reviewer_account_id IS NOT NULL AND rejection_reason IS NULL)
        OR (status = 'REJECTED' AND reviewed_at IS NOT NULL AND reviewer_account_id IS NOT NULL AND char_length(btrim(rejection_reason)) > 0)
      )
    );
    CREATE INDEX doctor_applications_pending_submitted
      ON doctor_applications(status, submitted_at ASC) WHERE status = 'PENDING';
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE doctor_applications;');
};

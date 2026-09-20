/* theCliniQ Phase 7.1A: appointment-bound patient-doctor chat. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY, appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
      patient_profile_id uuid NOT NULL REFERENCES patient_profiles(id) ON DELETE RESTRICT,
      doctor_profile_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT current_timestamp
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
      sender_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      message_type text NOT NULL, body text NOT NULL, idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      CHECK (message_type='TEXT'), CHECK (char_length(btrim(body))>0), CHECK (char_length(btrim(idempotency_key))>0),
      UNIQUE (conversation_id,sender_account_id,idempotency_key)
    );
    CREATE INDEX messages_conversation_order ON messages(conversation_id,created_at,id);
    CREATE FUNCTION conversation_appointment_guard() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM appointment_participants p WHERE p.appointment_id=NEW.appointment_id AND p.participant_type='PATIENT' AND p.patient_profile_id=NEW.patient_profile_id)
        OR NOT EXISTS (SELECT 1 FROM appointment_participants p WHERE p.appointment_id=NEW.appointment_id AND p.participant_type='DOCTOR' AND p.doctor_profile_id=NEW.doctor_profile_id) THEN
        RAISE EXCEPTION 'conversation participants must match appointment participants';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER conversations_appointment_integrity BEFORE INSERT OR UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION conversation_appointment_guard();
    CREATE FUNCTION conversation_immutable_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'conversation identity cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER conversations_identity_immutable BEFORE UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION conversation_immutable_guard();
    CREATE FUNCTION message_sender_guard() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM conversations c JOIN patient_profiles p ON p.id=c.patient_profile_id WHERE c.id=NEW.conversation_id AND p.account_id=NEW.sender_account_id)
        AND NOT EXISTS (SELECT 1 FROM conversations c JOIN doctor_profiles d ON d.id=c.doctor_profile_id WHERE c.id=NEW.conversation_id AND d.account_id=NEW.sender_account_id) THEN
        RAISE EXCEPTION 'message sender must be a conversation participant';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER messages_sender_participation BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION message_sender_guard();
    CREATE FUNCTION message_immutable_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'message cannot be changed'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION message_immutable_guard();
  `);
};
exports.down = (pgm) => pgm.sql(`DROP TRIGGER messages_immutable ON messages; DROP FUNCTION message_immutable_guard(); DROP TRIGGER messages_sender_participation ON messages; DROP FUNCTION message_sender_guard(); DROP TRIGGER conversations_identity_immutable ON conversations; DROP FUNCTION conversation_immutable_guard(); DROP TRIGGER conversations_appointment_integrity ON conversations; DROP FUNCTION conversation_appointment_guard(); DROP TABLE messages; DROP TABLE conversations;`);

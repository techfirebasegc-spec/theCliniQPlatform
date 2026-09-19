import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5.8 network booking/referral persistence migration contract', () => {
  it('creates restrictive, immutable network booking, referral, and queue evidence', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260924000000_phase5_network_booking_referral_persistence.js', import.meta.url), 'utf8');

    for (const table of [
      'patient_delegated_booking_authorization_policy_versions',
      'patient_clinic_booking_authorizations',
      'appointment_referral_policy_versions',
      'appointment_referrals',
      'referral_consent_events',
      'network_booking_contexts',
      'service_offering_version_queue_policies',
      'queue_windows',
      'queue_entries',
    ]) expect(migration).toContain(`CREATE TABLE ${table}`);

    expect(migration).toContain("status='ACTIVE' AND consuming_appointment_intent_id IS NULL");
    expect(migration).toContain("status='CONSUMED' AND consuming_appointment_intent_id IS NOT NULL");
    expect(migration).toContain('patient delegated booking authorization cannot reactivate');
    expect(migration).toContain('patient delegated booking authorization cannot be deleted');
    expect(migration).toContain('patient delegated booking authorization queue window is inconsistent');
    expect(migration).toContain('FROM queue_windows queue_window JOIN service_offering_versions version ON version.id=queue_window.service_offering_version_id WHERE queue_window.id=NEW.queue_window_id');
    expect(migration).toContain('patient delegated booking authorization must begin active');
    expect(migration).toContain('expired patient delegated booking authorization cannot be consumed');
    expect(migration).toContain('patient delegated booking authorization revocation requires patient actor');
    expect(migration).toContain('consumed delegated authorization requires exact network booking context');
    expect(migration).toContain('consumed referral requires exact network booking context');
    expect(migration).toContain('UNIQUE (queue_window_id, queue_position)');
    expect(migration).toContain('queue window capacity is exceeded');
    expect(migration).toContain('NEW.queue_position := next_position');
    expect(migration).toContain('queue entry capacity release is inconsistent with appointment lifecycle');
    expect(migration).toContain('SELECT maximum_capacity INTO capacity_limit FROM queue_windows WHERE id=NEW.queue_window_id FOR UPDATE');
    expect(migration).toContain('appointment_intent_queue_window_lock_guard');
    expect(migration).toContain('CREATE TRIGGER queue_entries_capacity_integrity BEFORE INSERT OR UPDATE OF queue_window_id,capacity_status ON queue_entries');
    expect(migration).toContain('queue entry evidence is immutable');
    expect(migration).toContain('queue entry evidence cannot be deleted');
    expect(migration).toContain('queue entry must be attached to its exact appointment intent');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER queue_entries_intent_attachment_integrity');
    expect(migration).toContain('queue entry status is inconsistent with appointment lifecycle');
    expect(migration).toContain("appointment_status IS NOT DISTINCT FROM 'CANCELLED'");
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER queue_entries_status_integrity');
    expect(migration).toContain('queue network booking context requires exact queue entry');
    expect(migration).toContain('queue policy cannot be changed');
    expect(migration).toContain('service_offering_version_queue_policies_integrity BEFORE UPDATE OR DELETE');
    expect(migration).toContain("status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC','ACCEPTED','CONSUMED','REJECTED','WITHDRAWN','EXPIRED')");
    expect(migration).toContain('appointment_referrals_pending_unique');
    expect(migration).toContain("WHERE status IN ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC')");
    expect(migration).toContain('referral consent evidence cannot be changed');
    expect(migration).toContain('withdrawn referral consent prevents acceptance or consumption');
    expect(migration).toContain('SELECT status INTO final_status FROM appointment_referrals WHERE id=NEW.id');
    expect(migration).toContain('withdrawn referral consent requires withdrawn referral lifecycle');
    expect(migration).toContain('appointment referral receiving action requires authorized clinic actor');
    expect(migration).toContain('appointment referral withdrawal requires authorized actor');
    expect(migration).toContain('appointment referral cannot be deleted');
    expect(migration).toContain("status='EXPIRED'");
    expect(migration).toContain('accepted_by_account_id IS NULL');
    expect(migration).toContain('referral.network_connection_id IS DISTINCT FROM NEW.network_connection_id');
    expect(migration).toContain('capability.grantor_doctor_profile_id IS DISTINCT FROM intent_row.provider_doctor_profile_id');
    expect(migration).toContain("record_category IN ('PAYMENT','REFUND','SETTLEMENT','RECONCILIATION','ADJUSTMENT','AUDIT','WEBHOOK','REFERRAL')");
    expect(migration).toContain("booking_relationship IN ('PATIENT_PROVIDER','CLINIC_DOCTOR','CLINIC_CLINIC')");
    expect(migration).toContain("(booking_relationship='CLINIC_CLINIC' AND capability_key='REFER')");
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).toContain('cannot roll back Phase 5.8 network booking persistence while evidence exists');
    expect(migration).toContain("retention_policy_versions WHERE record_category='REFERRAL'");
    expect(migration).toContain("legal_holds WHERE record_category='REFERRAL'");
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5.4 appointment participant migration contract', () => {
  it('creates immutable profile/clinic participant evidence with deferred context completeness', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260919000000_phase5_appointment_participants.js', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE TABLE appointment_participants');
    expect(migration).toContain("participant_type IN ('PATIENT','DOCTOR','CLINIC')");
    expect(migration).toContain('UNIQUE (appointment_id, participant_type)');
    expect(migration).toContain("participant_type = 'PATIENT' AND patient_profile_id IS NOT NULL");
    expect(migration).toContain("participant_type = 'DOCTOR' AND patient_profile_id IS NULL AND doctor_profile_id IS NOT NULL");
    expect(migration).toContain("participant_type = 'CLINIC' AND patient_profile_id IS NULL AND doctor_profile_id IS NULL AND clinic_id IS NOT NULL AND tenant_id IS NOT NULL");
    expect(migration).toContain('appointment requires exactly one patient participant');
    expect(migration).toContain('appointment doctor participant does not match appointment context');
    expect(migration).toContain('appointment clinic participant does not match appointment context');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('appointment participant cannot be changed');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).toContain('cannot roll back appointment participants while participant records exist');
    expect(migration).not.toContain('appointment.manage');
  });
});

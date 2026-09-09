import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Step 3.1 migration contract', () => {
  it('creates only intent, reservation, and versioned hold-policy foundations', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260913000000_phase5_appointment_intent_reservations.js', import.meta.url), 'utf8');
    for (const table of ['appointment_intents', 'slot_reservations', 'service_offering_version_reservation_policies']) expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain('provider_doctor_profile_id IS NOT NULL AND provider_clinic_id IS NULL'); expect(migration).toContain('UNIQUE (booking_actor_account_id, idempotency_key)'); expect(migration).toContain("status IN ('HELD','RELEASED','EXPIRED')"); expect(migration).toContain('appointment intent booking context is immutable'); expect(migration).toContain('cannot be reactivated'); expect(migration).not.toContain('CREATE TABLE appointment_intent_events'); expect(migration).not.toContain('Razorpay');
  });
});

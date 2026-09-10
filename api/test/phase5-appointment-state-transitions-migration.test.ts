import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Step 5.2 appointment transition migration contract', () => {
  it('extends the vocabulary and preserves append-only appointment evidence', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260917000000_phase5_appointment_state_transitions.js', import.meta.url), 'utf8');
    expect(migration).toContain("'PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED'");
    expect(migration).toContain("OLD.status='PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','PAYMENT_FAILED','EXPIRED')");
    expect(migration).toContain("NEW.event_type='CONFIRMED' AND NOT (NEW.previous_status='PAYMENT_PENDING'");
    expect(migration).toContain('appointment state transition requires matching immutable event');
    expect(migration).toContain('CREATE UNIQUE INDEX appointment_events_transition_once');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('cannot roll back appointment state transitions while payment-pending appointment history exists');
    expect(migration).not.toContain('DROP TABLE appointments');
    expect(migration).not.toContain('Razorpay');
  });
});

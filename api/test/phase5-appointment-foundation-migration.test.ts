import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Step 5.1 appointment migration contract', () => {
  it('creates immutable appointment and event foundations without later workflows', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260916000000_phase5_appointment_foundation.js', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE TABLE appointments');
    expect(migration).toContain('CREATE TABLE appointment_events');
    expect(migration).toContain("status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','PAYMENT_FAILED')");
    expect(migration).toContain("event_type IN ('CONFIRMED','STARTED','COMPLETED','CANCELLED','RESCHEDULE_REQUESTED','RESCHEDULED','EXPIRED','PAYMENT_FAILED','SUPPORT_EXCEPTION')");
    expect(migration).toContain('appointment event cannot be changed');
    expect(migration).toContain('appointment historical context is immutable');
    expect(migration).not.toContain('CREATE TABLE appointment_reschedules');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).not.toContain('Razorpay');
  });
});

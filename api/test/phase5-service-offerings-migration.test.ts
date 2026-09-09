import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Step 1 Service Offering migration contract', () => {
  it('enforces explicit exactly-one owner, exact money, non-overlapping periods, and immutable versions', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260911000000_phase5_service_offerings.js', import.meta.url), 'utf8');
    for (const table of ['service_offerings', 'service_offering_versions', 'service_offering_prices']) expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain('owner_doctor_profile_id uuid REFERENCES doctor_profiles'); expect(migration).toContain('owner_clinic_id uuid REFERENCES clinics'); expect(migration).toContain('owner_doctor_profile_id IS NOT NULL AND owner_clinic_id IS NULL'); expect(migration).toContain('owner_doctor_profile_id IS NULL AND owner_clinic_id IS NOT NULL');
    expect(migration).toContain("EXCLUDE USING gist (service_offering_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)"); expect(migration).toContain("currency ~ '^[A-Z]{3}$'"); expect(migration).toContain('amount_minor bigint NOT NULL'); expect(migration).not.toContain('double precision'); expect(migration).toContain('service offering versions are immutable'); expect(migration).toContain('service offering prices are immutable');
  });
});

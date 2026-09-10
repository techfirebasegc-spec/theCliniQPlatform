import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Service Exposure migration contract', () => {
  it('enforces explicit exposure ownership, lifecycle, retention, and intent snapshotting', async () => {
    const migration=await readFile(new URL('../../database/migrations/20260914000000_phase5_service_exposures.js',import.meta.url),'utf8');
    expect(migration).toContain('CREATE TABLE service_exposures'); expect(migration).toContain('service_offering_id uuid NOT NULL UNIQUE'); expect(migration).toContain("status IN ('DRAFT','PUBLISHED','UNPUBLISHED')"); expect(migration).toContain('service exposure provider must match service offering owner'); expect(migration).toContain('service exposure tenant must match clinic tenant'); expect(migration).toContain('service exposure must be created as draft'); expect(migration).toContain('service exposure lifecycle transition is invalid'); expect(migration).toContain('service_exposure_id uuid REFERENCES service_exposures(id) ON DELETE RESTRICT'); expect(migration).toContain('appointment intent exposure context is inconsistent'); expect(migration).toContain('appointment intent booking context is immutable'); expect(migration).toContain('cannot roll back service exposures while appointment intents reference exposures'); expect(migration).not.toContain('ON DELETE CASCADE');
  });
});

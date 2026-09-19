import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 6.3A provider payment account migration contract', () => {
  it('adds provider-neutral payment accounts and replaces the settlement beneficiary FK', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260925000000_phase6_provider_payment_accounts.js', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE TABLE provider_payment_accounts');
    expect(migration).toContain("provider_kind IN ('DOCTOR','CLINIC')");
    expect(migration).toContain("status IN ('PENDING','ACTIVE','SUSPENDED','DISABLED')");
    expect(migration).toContain("verification_status IN ('NOT_SUBMITTED','PENDING','VERIFIED','REJECTED')");
    expect(migration).toContain('provider_payment_accounts_active_doctor_provider_unique');
    expect(migration).toContain('provider_payment_accounts_active_clinic_provider_unique');
    expect(migration).toContain('provider payment account identity cannot be changed');
    expect(migration).toContain('provider_payment_account_id uuid NOT NULL REFERENCES provider_payment_accounts(id) ON DELETE RESTRICT');
    expect(migration).toContain('ALTER TABLE settlements DROP COLUMN provider_account_id');
    expect(migration).toContain('cannot migrate settlements to provider payment accounts while settlement history exists');
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 5 Step 2 Availability migration contract', () => {
  it('creates only configuration entities with recurrence, local/UTC, and window integrity guards', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260912000000_phase5_availability_foundation.js', import.meta.url), 'utf8');
    for (const table of ['availability_configurations', 'availability_rules', 'availability_windows', 'availability_exceptions']) expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain('availability_rules_effective_identity_excl'); expect(migration).toContain('recurrence_identity WITH ='); expect(migration).toContain('availability_derive_utc'); expect(migration).toContain('NEW.derived_start_utc := start_value'); expect(migration).toContain('availability windows overlap'); expect(migration).toContain('availability break must be contained'); expect(migration).toContain('DROP TABLE availability_exceptions'); expect(migration).not.toContain('CREATE TABLE reservations'); expect(migration).not.toContain('CREATE TABLE appointment_slots');
  });

  it('keeps the disposable verification fixture executable rather than comment-only', async () => {
    const fixture = await readFile(new URL('../../docs/verification/phase5-availability-foundation-verification.sql', import.meta.url), 'utf8');
    expect(fixture).toContain('BEGIN;'); expect(fixture).toContain('ROLLBACK;'); expect(fixture).toContain('INSERT INTO accounts'); expect(fixture).toContain('EXCEPTION WHEN exclusion_violation'); expect(fixture).toContain('PASS: Canonical recurrence identity overlap, adjacency, and difference checks'); expect(fixture).toContain('PASS: exception local/UTC guard, DST, one-off, and conflict checks'); expect(fixture).not.toContain('replace this comment block');
  });
});

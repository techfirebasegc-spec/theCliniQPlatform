import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('theCliniQ Phase 4 financial migration contract', () => {
  it('contains normalized financial, provider, ledger, retention, and immutability controls', async () => {
    const migration = await readFile(new URL('../../database/migrations/20260910000000_phase4_financial_foundation.js', import.meta.url), 'utf8');
    for (const table of ['commercial_rules','commercial_rule_versions','financial_allocation_snapshots','financial_allocation_components','payment_intents','payments','refunds','settlements','provider_webhook_events','reconciliation_records','financial_adjustments','financial_adjustment_approvals','ledger_accounts','ledger_transactions','ledger_entries','legal_holds']) expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain('financial_allocation_snapshots_immutable'); expect(migration).toContain('posted ledger transaction must balance'); expect(migration).toContain('ledger_entries_immutable BEFORE INSERT OR UPDATE OR DELETE'); expect(migration).toContain('financial adjustment requester cannot approve own adjustment'); expect(migration).toContain('invalid provider webhook state transition'); expect(migration).toContain('UNIQUE (provider_key, provider_event_id)'); expect(migration).toContain('amount_minor bigint'); expect(migration).not.toContain('double precision');
  });
});

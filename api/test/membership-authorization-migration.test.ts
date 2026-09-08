import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Call = { name: string; args: unknown[] };
const require = createRequire(import.meta.url);
const migration = require('../../database/migrations/20260908000000_phase2_membership_authorization.js') as { up: (pgm: Recorder) => void; down: (pgm: Recorder) => void };
class Recorder {
  public calls: Call[] = [];
  public dropConstraint(...args: unknown[]) { this.calls.push({ name: 'dropConstraint', args }); }
  public addConstraint(...args: unknown[]) { this.calls.push({ name: 'addConstraint', args }); }
  public createExtension(...args: unknown[]) { this.calls.push({ name: 'createExtension', args }); }
  public createTable(...args: unknown[]) { this.calls.push({ name: 'createTable', args }); }
  public createIndex(...args: unknown[]) { this.calls.push({ name: 'createIndex', args }); }
  public dropTable(...args: unknown[]) { this.calls.push({ name: 'dropTable', args }); }
  public sql(...args: unknown[]) { this.calls.push({ name: 'sql', args }); }
  public func(value: string) { return value; }
}
describe('Phase 2 membership authorization migration', () => {
  it('supports only the approved roles and creates secure invitations', () => {
    const recorder = new Recorder(); migration.up(recorder);
    expect(recorder.calls.find((call) => call.name === 'addConstraint' && call.args[1] === 'tenant_memberships_role_check')?.args[2]).toEqual({ check: "role_key IN ('CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF', 'DOCTOR', 'PATIENT')" });
    expect(recorder.calls.find((call) => call.name === 'createTable' && call.args[0] === 'tenant_invitations')).toBeTruthy();
    expect(recorder.calls.find((call) => call.name === 'createIndex' && (call.args[2] as { name?: string })?.name === 'tenant_invitations_open_target_unique')).toBeTruthy();
  });
  it('fails before backfill rather than promoting a non-owner creator, then only backfills creators with no membership', () => {
    const recorder = new Recorder(); migration.up(recorder);
    const sql = recorder.calls.filter((call) => call.name === 'sql').map((call) => String(call.args[0])).join('\n');
    expect(sql).toContain("creator_membership.role_key <> 'CLINIC_OWNER'");
    expect(sql).toContain('active tenant creator has a non-owner active or invited membership without an active clinic owner');
    expect(sql).toContain('AND existing.account_id = tenants.created_by_account_id\n      );');
  });
  it('refuses down migration when authorization data would be lost', () => {
    const recorder = new Recorder(); migration.down(recorder);
    const sql = recorder.calls.filter((call) => call.name === 'sql').map((call) => String(call.args[0])).join('\n');
    expect(sql).toContain('tenant_invitations');
    expect(sql).toContain("role_key IN ('DOCTOR', 'PATIENT')");
  });
});

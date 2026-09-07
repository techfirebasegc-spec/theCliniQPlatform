import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Call = {
  name: string;
  args: unknown[];
};

const require = createRequire(import.meta.url);
const migration = require('../../database/migrations/20260907000000_phase2_foundation.js') as {
  down: (pgm: MigrationRecorder) => void;
  up: (pgm: MigrationRecorder) => void;
};

class MigrationRecorder {
  public readonly calls: Call[] = [];

  public createTable(...args: unknown[]): void {
    this.calls.push({ name: 'createTable', args });
  }

  public addConstraint(...args: unknown[]): void {
    this.calls.push({ name: 'addConstraint', args });
  }

  public createIndex(...args: unknown[]): void {
    this.calls.push({ name: 'createIndex', args });
  }

  public dropTable(...args: unknown[]): void {
    this.calls.push({ name: 'dropTable', args });
  }

  public func(value: string): string {
    return value;
  }
}

function callsNamed(recorder: MigrationRecorder, name: string): Call[] {
  return recorder.calls.filter((call) => call.name === name);
}

describe('Phase 2 foundation migration', () => {
  it('creates exactly the approved foundation tables', () => {
    const recorder = new MigrationRecorder();
    migration.up(recorder);

    expect(callsNamed(recorder, 'createTable').map((call) => call.args[0])).toEqual([
      'accounts',
      'authentication_identities',
      'sessions',
      'patient_profiles',
      'doctor_profiles',
      'tenants',
      'clinics',
      'tenant_memberships',
      'network_connections',
      'network_connection_capabilities',
      'network_connection_events',
      'audit_events',
    ]);
  });

  it('defines only DISCOVER and CONTACT as active capability vocabulary', () => {
    const recorder = new MigrationRecorder();
    migration.up(recorder);
    const capabilityConstraint = callsNamed(recorder, 'addConstraint').find((call) => call.args[1] === 'network_connection_capabilities_key_check');

    expect(capabilityConstraint?.args[2]).toEqual({ check: "capability_key IN ('DISCOVER', 'CONTACT')" });
  });

  it('records critical connection and membership integrity constraints', () => {
    const recorder = new MigrationRecorder();
    migration.up(recorder);
    const constraints = callsNamed(recorder, 'addConstraint').map((call) => call.args[1]);
    const indexes = callsNamed(recorder, 'createIndex').map((call) => call.args[2]);

    expect(constraints).toContain('network_connections_party_shape_check');
    expect(constraints).toContain('sessions_absolute_expiry_check');
    expect(constraints).toContain('sessions_idle_expiry_check');
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'tenant_memberships_active_or_invited_unique', unique: true }));
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'network_connections_active_clinic_clinic_unique', unique: true }));
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'network_connection_capabilities_active_unique', unique: true }));
  });

  it('drops every foundation table in reverse dependency order', () => {
    const recorder = new MigrationRecorder();
    migration.down(recorder);

    expect(callsNamed(recorder, 'dropTable').map((call) => call.args[0])).toEqual([
      'audit_events',
      'network_connection_events',
      'network_connection_capabilities',
      'network_connections',
      'tenant_memberships',
      'clinics',
      'tenants',
      'doctor_profiles',
      'patient_profiles',
      'sessions',
      'authentication_identities',
      'accounts',
    ]);
  });
});

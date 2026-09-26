import { describe, expect, it } from 'vitest';
import { AdminProvisioner, requireAdminProvisioningTarget, requireFirebaseUid } from '../src/modules/admin-access/admin-provisioning.js';
import type { DatabaseHealth } from '../src/infrastructure/database.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';

type Query = { text: string; values: readonly unknown[] };

function database(options: { existing?: boolean; schema?: boolean; failEntitlement?: boolean } = {}) {
  const committed: Query[] = [];
  let rolledBack = false;
  const db: DatabaseHealth = {
    async ping() {},
    async close() {},
    async query() { return { rows: [] }; },
    async transaction<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T> {
      const pending: Query[] = [];
      const executor: PostgresExecutor = {
        async query<T extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
          if (text.includes('to_regclass')) return { rows: [{ entitlement_table_exists: options.schema ?? true, firebase_password_supported: options.schema ?? true }] as T[] };
          if (text.includes('SELECT 1 FROM authentication_identities')) return { rows: options.existing ? ([{ '?column?': 1 }] as T[]) : [] };
          if (options.failEntitlement && text.includes('INSERT INTO platform_admin_entitlements')) throw new Error('entitlement insert failed');
          pending.push({ text, values });
          return { rows: [] as T[] };
        },
      };
      try {
        const result = await operation(executor);
        committed.push(...pending);
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  return { db, committed, rolledBack: () => rolledBack };
}

describe('AdminProvisioner', () => {
  it('creates exactly an active account, password identity, and active entitlement in one transaction', async () => {
    const fixture = database();
    const identifiers = ['account-id', 'identity-id', 'entitlement-id'];
    const provisioned = await new AdminProvisioner(fixture.db, () => identifiers.shift()!, () => new Date('2026-09-30T00:00:00Z')).provision('firebase-uid', 'local');
    expect(provisioned).toEqual({ firebaseUid: 'firebase-uid', accountId: 'account-id', entitlementId: 'entitlement-id', target: 'local' });
    expect(fixture.committed).toHaveLength(3);
    expect(fixture.committed.map((query) => query.text)).toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO accounts'), expect.stringContaining('INSERT INTO authentication_identities'), expect.stringContaining('INSERT INTO platform_admin_entitlements')]));
  });

  it('aborts without writes when the Firebase UID already has an identity', async () => {
    const fixture = database({ existing: true });
    await expect(new AdminProvisioner(fixture.db).provision('firebase-uid', 'staging')).rejects.toMatchObject({ code: 'FIREBASE_IDENTITY_ALREADY_PROVISIONED' });
    expect(fixture.committed).toEqual([]);
    expect(fixture.rolledBack()).toBe(true);
  });

  it('rolls back all writes when entitlement creation fails', async () => {
    const fixture = database({ failEntitlement: true });
    await expect(new AdminProvisioner(fixture.db).provision('firebase-uid', 'local')).rejects.toThrow('entitlement insert failed');
    expect(fixture.committed).toEqual([]);
    expect(fixture.rolledBack()).toBe(true);
  });

  it('aborts without writes when the approved migration is unavailable', async () => {
    const fixture = database({ schema: false });
    await expect(new AdminProvisioner(fixture.db).provision('firebase-uid', 'local')).rejects.toMatchObject({ code: 'ADMIN_PROVISIONING_SCHEMA_UNAVAILABLE' });
    expect(fixture.committed).toEqual([]);
    expect(fixture.rolledBack()).toBe(true);
  });
});

describe('Admin provisioning guardrails', () => {
  it('requires the exact production target to allow production provisioning', () => {
    expect(() => requireAdminProvisioningTarget({ nodeEnvironment: 'production', target: undefined })).toThrow('ADMIN_PROVISIONING_PRODUCTION_FORBIDDEN');
    expect(() => requireAdminProvisioningTarget({ nodeEnvironment: 'production', target: 'staging' })).toThrow('ADMIN_PROVISIONING_PRODUCTION_FORBIDDEN');
    expect(requireAdminProvisioningTarget({ nodeEnvironment: 'production', target: 'production' })).toBe('production');
  });

  it('keeps existing non-production target restrictions', () => {
    expect(() => requireAdminProvisioningTarget({ nodeEnvironment: 'development', target: undefined })).toThrow('ADMIN_PROVISIONING_TARGET_REQUIRED');
    expect(() => requireAdminProvisioningTarget({ nodeEnvironment: 'development', target: 'production' })).toThrow('ADMIN_PROVISIONING_TARGET_REQUIRED');
    expect(requireAdminProvisioningTarget({ nodeEnvironment: 'development', target: 'local' })).toBe('local');
    expect(requireAdminProvisioningTarget({ nodeEnvironment: 'test', target: 'staging' })).toBe('staging');
  });

  it('requires exactly one nonblank Firebase UID value', () => {
    expect(requireFirebaseUid(' firebase-uid ')).toBe('firebase-uid');
    expect(() => requireFirebaseUid('   ')).toThrow('ADMIN_PROVISIONING_INVALID_FIREBASE_UID');
  });
});

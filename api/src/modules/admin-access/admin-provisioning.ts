import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type AdminProvisioningTarget = 'local' | 'staging';

export class AdminProvisioningError extends Error {
  public constructor(public readonly code: 'ADMIN_PROVISIONING_PRODUCTION_FORBIDDEN' | 'ADMIN_PROVISIONING_TARGET_REQUIRED' | 'ADMIN_PROVISIONING_INVALID_FIREBASE_UID' | 'ADMIN_PROVISIONING_SCHEMA_UNAVAILABLE' | 'FIREBASE_IDENTITY_ALREADY_PROVISIONED') {
    super(code);
  }
}

export type AdminProvisioningEnvironment = {
  nodeEnvironment: string | undefined;
  target: string | undefined;
};

export type ProvisionedAdmin = {
  firebaseUid: string;
  accountId: string;
  entitlementId: string;
  target: AdminProvisioningTarget;
};

type SchemaCheck = { entitlement_table_exists: boolean; firebase_password_supported: boolean };

export function requireAdminProvisioningTarget(environment: AdminProvisioningEnvironment): AdminProvisioningTarget {
  if (environment.nodeEnvironment === 'production') throw new AdminProvisioningError('ADMIN_PROVISIONING_PRODUCTION_FORBIDDEN');
  if (environment.target === 'local' || environment.target === 'staging') return environment.target;
  throw new AdminProvisioningError('ADMIN_PROVISIONING_TARGET_REQUIRED');
}

export function requireFirebaseUid(value: string | undefined): string {
  const firebaseUid = value?.trim();
  if (!firebaseUid) throw new AdminProvisioningError('ADMIN_PROVISIONING_INVALID_FIREBASE_UID');
  return firebaseUid;
}

export class AdminProvisioner {
  public constructor(
    private readonly database: DatabaseHealth,
    private readonly identifiers: () => string = createIdentifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async provision(firebaseUid: string, target: AdminProvisioningTarget): Promise<ProvisionedAdmin> {
    return this.database.transaction(async (database) => {
      await this.requireSupportedSchema(database);

      const existing = await database.query('SELECT 1 FROM authentication_identities WHERE provider = $1 AND provider_subject = $2 LIMIT 1', ['firebase_password', firebaseUid]);
      if (existing.rows.length > 0) throw new AdminProvisioningError('FIREBASE_IDENTITY_ALREADY_PROVISIONED');

      const accountId = this.identifiers();
      const identityId = this.identifiers();
      const entitlementId = this.identifiers();
      const timestamp = this.now();

      await database.query('INSERT INTO accounts (id, status, display_name, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, NULL, NULL)', [accountId, 'ACTIVE', 'Admin']);
      await database.query('INSERT INTO authentication_identities (id, account_id, provider, provider_subject, status, verified_at, linked_at, last_authenticated_at, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $4, $5, $6, $6, NULL, NULL, NULL)', [identityId, accountId, 'firebase_password', firebaseUid, 'LINKED', timestamp]);
      await database.query('INSERT INTO platform_admin_entitlements (id, account_id, status, granted_at, granted_by_account_id, revoked_at, revoked_by_account_id, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL)', [entitlementId, accountId, 'ACTIVE', timestamp]);

      return { firebaseUid, accountId, entitlementId, target };
    });
  }

  private async requireSupportedSchema(database: PostgresExecutor): Promise<void> {
    const result = await database.query<SchemaCheck>(`
      SELECT
        to_regclass('public.platform_admin_entitlements') IS NOT NULL AS entitlement_table_exists,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.authentication_identities'::regclass
            AND conname = 'authentication_identities_provider_check'
            AND pg_get_constraintdef(oid) LIKE '%firebase_password%'
        ) AS firebase_password_supported
    `, []);
    const schema = result.rows[0];
    if (!schema?.entitlement_table_exists || !schema.firebase_password_supported) {
      throw new AdminProvisioningError('ADMIN_PROVISIONING_SCHEMA_UNAVAILABLE');
    }
  }
}

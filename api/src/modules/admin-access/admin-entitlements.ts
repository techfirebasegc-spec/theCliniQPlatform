import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export interface PlatformAdminEntitlementRepository {
  hasActiveForAccount(accountId: string): Promise<boolean>;
  hasActiveForAccountInTransaction(database: PostgresExecutor, accountId: string): Promise<boolean>;
}

export class PlatformAdminEntitlementService {
  public constructor(private readonly repository: PlatformAdminEntitlementRepository) {}

  public async hasActiveEntitlement(accountId: string): Promise<boolean> {
    return this.repository.hasActiveForAccount(accountId);
  }

  public async hasActiveEntitlementInTransaction(database: PostgresExecutor, accountId: string): Promise<boolean> {
    return this.repository.hasActiveForAccountInTransaction(database, accountId);
  }
}

export class PostgresPlatformAdminEntitlementRepository implements PlatformAdminEntitlementRepository {
  public constructor(private readonly database: PostgresExecutor) {}

  public async hasActiveForAccount(accountId: string): Promise<boolean> {
    const result = await this.database.query('SELECT 1 FROM platform_admin_entitlements WHERE account_id = $1 AND status = $2 LIMIT 1', [accountId, 'ACTIVE']);
    return result.rows.length > 0;
  }

  public async hasActiveForAccountInTransaction(database: PostgresExecutor, accountId: string): Promise<boolean> {
    const result = await database.query('SELECT 1 FROM platform_admin_entitlements WHERE account_id = $1 AND status = $2 FOR SHARE', [accountId, 'ACTIVE']);
    return result.rows.length > 0;
  }
}

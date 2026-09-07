import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AccountIdentityRecord, AccountIdentityRepository, VerifiedFirebaseIdentity } from './identity.js';
import type { Pool, PoolClient } from 'pg';

type IdentityRow = { account_id: string; id: string; account_status: AccountIdentityRecord['accountStatus'] };

export class PostgresAccountIdentityRepository implements AccountIdentityRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByProviderSubject(identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord | null> {
    return this.find(this.pool, identity);
  }

  public async createAccountWithIdentity(identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.find(client, identity);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const accountId = createIdentifier();
      const identityId = createIdentifier();
      await client.query('INSERT INTO accounts (id, status) VALUES ($1, $2)', [accountId, 'PENDING_VERIFICATION']);
      await client.query('INSERT INTO authentication_identities (id, account_id, provider, provider_subject, status, verified_at, linked_at) VALUES ($1, $2, $3, $4, $5, $6, $6)', [identityId, accountId, identity.provider, identity.subject, 'LINKED', identity.verifiedAt]);
      await client.query('COMMIT');
      return { accountId, identityId, accountStatus: 'PENDING_VERIFICATION' };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        const existing = await this.find(this.pool, identity);
        if (existing) return existing;
      }
      throw new Error('IDENTITY_MAPPING_FAILED');
    } finally {
      client.release();
    }
  }

  public async linkIdentityToAccount(accountId: string, identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord> {
    const identityId = createIdentifier();
    try {
      await this.pool.query('INSERT INTO authentication_identities (id, account_id, provider, provider_subject, status, verified_at, linked_at, created_by_account_id) VALUES ($1, $2, $3, $4, $5, $6, $6, $2)', [identityId, accountId, identity.provider, identity.subject, 'LINKED', identity.verifiedAt]);
      const account = await this.pool.query<{ status: AccountIdentityRecord['accountStatus'] }>('SELECT status FROM accounts WHERE id = $1', [accountId]);
      if (!account.rows[0]) throw new Error('ACCOUNT_NOT_FOUND');
      return { accountId, identityId, accountStatus: account.rows[0].status };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const existing = await this.find(this.pool, identity);
        if (existing?.accountId === accountId) return existing;
      }
      throw new Error('IDENTITY_MAPPING_FAILED');
    }
  }

  public async markAuthenticated(identityId: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE authentication_identities SET last_authenticated_at = $2, updated_at = $2 WHERE id = $1', [identityId, at]);
  }

  private async find(executor: Pick<Pool, 'query'> | PoolClient, identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord | null> {
    const result = await executor.query<IdentityRow>('SELECT authentication_identities.account_id, authentication_identities.id, accounts.status AS account_status FROM authentication_identities JOIN accounts ON accounts.id = authentication_identities.account_id WHERE authentication_identities.provider = $1 AND authentication_identities.provider_subject = $2 AND authentication_identities.status = $3', [identity.provider, identity.subject, 'LINKED']);
    const row = result.rows[0];
    return row ? { accountId: row.account_id, identityId: row.id, accountStatus: row.account_status } : null;
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

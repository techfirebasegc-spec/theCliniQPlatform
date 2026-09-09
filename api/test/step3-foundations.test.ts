import { AccountIdentityService, type FirebaseIdentityVerifier } from '../src/modules/identity/identity.js';
import { PostgresAccountIdentityRepository } from '../src/modules/identity/postgres-account-identity-repository.js';
import { assertTenantPermission, authorizeTenant, hasTenantPermission } from '../src/modules/authorization/authorization.js';
import { authenticateSession, createSession, sessionCookieOptions, sessionCookieValue, type StoredSession } from '../src/modules/sessions/session.js';
import { PostgresSessionRepository } from '../src/modules/sessions/postgres-session-repository.js';
import { loadEnvironment } from '../src/config/environment.js';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

const firebase: FirebaseIdentityVerifier = { verify: async () => ({ provider: 'firebase_google', subject: 'firebase-uid', verifiedAt: new Date() }) };
const identity = { provider: 'firebase_google' as const, subject: 'firebase-uid', verifiedAt: new Date('2026-01-01T00:00:00Z') };

function repositoryWith(poolQuery: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, clientQuery: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) {
  const client = { query: clientQuery, release: () => {} };
  const pool = { query: poolQuery, connect: async () => client } as unknown as Pool;
  return new PostgresAccountIdentityRepository(pool);
}

describe('Step 3 foundations', () => {
  it('requires approved session configuration values', () => {
    expect(() => loadEnvironment({ NODE_ENV: 'test', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379' })).toThrow();
    expect(() => loadEnvironment({ NODE_ENV: 'test', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', FIREBASE_PROJECT_ID: 'project', SESSION_IDLE_TTL_SECONDS: '0', SESSION_ABSOLUTE_TTL_SECONDS: '1' })).toThrow();
    expect(() => loadEnvironment({ NODE_ENV: 'test', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', FIREBASE_PROJECT_ID: 'project', SESSION_IDLE_TTL_SECONDS: '3600', SESSION_ABSOLUTE_TTL_SECONDS: '60' })).toThrow();
  });

  it('maps a verified Firebase identity without duplicate account creation', async () => {
    const record = { accountId: 'account', identityId: 'identity', accountStatus: 'ACTIVE' as const };
    const repository = { findByProviderSubject: async () => record, createAccountWithIdentity: async () => { throw new Error('must not create'); }, markAuthenticated: async () => {} };
    await expect(new AccountIdentityService(repository).resolve('token', firebase)).resolves.toEqual(record);
  });

  it('creates an Account and AuthenticationIdentity atomically for a first identity', async () => {
    const calls: string[] = [];
    const repository = repositoryWith(async () => ({ rows: [] }), async (text) => { calls.push(text); return { rows: [] }; });
    const mapped = await repository.createAccountWithIdentity(identity);
    expect(mapped.accountStatus).toBe('PENDING_VERIFICATION');
    expect(calls).toContain('BEGIN');
    expect(calls.some((call) => call.startsWith('INSERT INTO accounts'))).toBe(true);
    expect(calls.some((call) => call.startsWith('INSERT INTO authentication_identities'))).toBe(true);
    expect(calls).toContain('COMMIT');
  });

  it('resolves an existing mapping and attaches a new identity to an existing Account', async () => {
    const existing = { account_id: 'existing-account', id: 'existing-identity', account_status: 'ACTIVE' };
    const repository = repositoryWith(async (text) => text.startsWith('SELECT authentication_identities') ? ({ rows: [existing] }) : ({ rows: [{ status: 'ACTIVE' }] }), async () => ({ rows: [existing] }));
    await expect(repository.findByProviderSubject(identity)).resolves.toEqual({ accountId: 'existing-account', identityId: 'existing-identity', accountStatus: 'ACTIVE' });
    await expect(repository.linkIdentityToAccount('existing-account', { ...identity, subject: 'second-firebase-uid' })).resolves.toMatchObject({ accountId: 'existing-account', accountStatus: 'ACTIVE' });
  });

  it('handles a provider-subject uniqueness race without exposing database details', async () => {
    const existing = { account_id: 'winner-account', id: 'winner-identity', account_status: 'ACTIVE' };
    const repository = repositoryWith(async () => ({ rows: [existing] }), async (text) => {
      if (text.startsWith('INSERT INTO authentication_identities')) throw { code: '23505', constraint: 'hidden_constraint' };
      return { rows: [] };
    });
    await expect(repository.createAccountWithIdentity(identity)).resolves.toEqual({ accountId: 'winner-account', identityId: 'winner-identity', accountStatus: 'ACTIVE' });
    const failing = repositoryWith(async () => ({ rows: [] }), async (text) => { if (text === 'BEGIN') throw new Error('database detail'); return { rows: [] }; });
    await expect(failing.createAccountWithIdentity(identity)).rejects.toThrow('IDENTITY_MAPPING_FAILED');
  });

  it('keeps the Firebase provider boundary and raw token outside persistence', async () => {
    const unsupported: FirebaseIdentityVerifier = { verify: async () => { throw new Error('UNSUPPORTED_FIREBASE_PROVIDER'); } };
    const repository = { findByProviderSubject: async () => null, createAccountWithIdentity: async () => { throw new Error('not reached'); }, markAuthenticated: async () => {} };
    await expect(new AccountIdentityService(repository).resolve('raw-firebase-token', unsupported)).rejects.toThrow('UNSUPPORTED_FIREBASE_PROVIDER');
  });

  it('creates hashed server-side session material and secure cookie values', () => {
    const session = createSession('account', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, new Date('2026-01-01T00:00:00Z'));
    expect(session.secretHash).not.toBe(session.rawSecret);
    expect(sessionCookieValue(session)).toContain('.');
    expect(sessionCookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    expect(session.absoluteExpiresAt.getTime()).toBeGreaterThan(session.idleExpiresAt.getTime());
  });

  it('enforces active tenant membership and fixed permission bundles', () => {
    const staff = { accountId: 'a', tenantId: 'tenant-a', role: 'CLINIC_STAFF' as const, status: 'ACTIVE' as const };
    expect(hasTenantPermission(staff, 'a', 'tenant-a', 'tenant.view')).toBe(true);
    expect(hasTenantPermission(staff, 'a', 'tenant-a', 'membership.manage')).toBe(false);
    expect(() => assertTenantPermission(staff, 'a', 'tenant-b', 'tenant.view')).toThrow('FORBIDDEN');
    expect(() => assertTenantPermission({ ...staff, status: 'REMOVED' }, 'a', 'tenant-a', 'tenant.view')).toThrow('FORBIDDEN');
    const owner = { ...staff, role: 'CLINIC_OWNER' as const };
    const admin = { ...staff, role: 'CLINIC_ADMIN' as const };
    expect(hasTenantPermission(owner, 'a', 'tenant-a', 'membership.manage')).toBe(true);
    expect(hasTenantPermission(admin, 'a', 'tenant-a', 'membership.manage')).toBe(true);
    expect(hasTenantPermission(owner, 'a', 'tenant-a', 'network.manage')).toBe(true);
    expect(hasTenantPermission(admin, 'a', 'tenant-a', 'network.manage')).toBe(true);
    expect(hasTenantPermission(staff, 'a', 'tenant-a', 'network.manage')).toBe(false);
  });

  it('persists only a session hash and can revoke a server-side session', async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const repository = new PostgresSessionRepository({ query: async (text, values) => { calls.push({ text, values }); return { rows: [] }; } });
    const session = createSession('account', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 });
    await repository.create('account', session);
    await repository.revoke(session.id, 'account', 'LOGOUT', new Date());
    expect(calls[0].text).toContain('INSERT INTO sessions');
    expect(calls[0].values).toContain(session.secretHash);
    expect(calls[0].values).not.toContain(session.rawSecret);
    expect(calls[1].text).toContain("status = 'REVOKED'");
  });

  it('authenticates only active sessions and enforces both expiry limits', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const created = createSession('account', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, now);
    const base: StoredSession = { id: created.id, accountId: 'account', status: 'ACTIVE', idleExpiresAt: new Date('2026-01-01T00:01:00Z'), absoluteExpiresAt: new Date('2026-01-01T00:02:00Z') };
    const touches: Date[] = [];
    const repository = { findBySecretHash: async () => base, touch: async (_id: string, _at: Date, expiresAt: Date) => { touches.push(expiresAt); return { updated: true }; } };
    await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, repository, now)).resolves.toEqual(base);
    expect(touches).toHaveLength(1);
    await expect(authenticateSession(undefined, { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, repository, now)).rejects.toThrow('UNAUTHORIZED');
    await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, { ...repository, findBySecretHash: async () => null }, now)).rejects.toThrow('UNAUTHORIZED');
    for (const status of ['REVOKED', 'REPLACED', 'EXPIRED', 'SUSPICIOUS'] as const) {
      await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, { ...repository, findBySecretHash: async () => ({ ...base, status }) }, now)).rejects.toThrow('UNAUTHORIZED');
    }
    await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, { ...repository, findBySecretHash: async () => ({ ...base, idleExpiresAt: now }) }, now)).rejects.toThrow('UNAUTHORIZED');
    await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, { ...repository, findBySecretHash: async () => ({ ...base, absoluteExpiresAt: now }) }, now)).rejects.toThrow('UNAUTHORIZED');
    await authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, { ...repository, findBySecretHash: async () => ({ ...base, idleExpiresAt: new Date('2026-01-01T00:02:00Z') }) }, new Date('2026-01-01T00:01:30Z'));
    expect(touches.at(-1)?.getTime()).toBe(base.absoluteExpiresAt.getTime());
  });

  it('fails closed when a conditional session touch loses a revoke, replacement, or expiry race', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const created = createSession('account', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, now);
    const active: StoredSession = { id: created.id, accountId: 'account', status: 'ACTIVE', idleExpiresAt: new Date('2026-01-01T00:01:00Z'), absoluteExpiresAt: new Date('2026-01-01T00:02:00Z') };
    for (const race of ['REVOKED', 'REPLACED', 'EXPIRED']) {
      const repository = { findBySecretHash: async () => active, touch: async () => ({ updated: false }) };
      await expect(authenticateSession(sessionCookieValue(created), { idleTtlSeconds: 60, absoluteTtlSeconds: 120 }, repository, now), race).rejects.toThrow('UNAUTHORIZED');
    }
  });

  it('reports whether the conditional PostgreSQL touch updated a session', async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const updated = new PostgresSessionRepository({ query: async (text, values) => { calls.push({ text, values }); return { rows: [], rowCount: 1 }; } });
    await expect(updated.touch('session', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:01:00Z'))).resolves.toEqual({ updated: true });
    expect(calls[0]?.text).toContain("status = 'ACTIVE'");
    expect(calls[0]?.text).toContain('idle_expires_at > $2');
    expect(calls[0]?.text).toContain('absolute_expires_at > $2');
    const unchanged = new PostgresSessionRepository({ query: async () => ({ rows: [], rowCount: 0 }) });
    await expect(unchanged.touch('session', new Date(), new Date())).resolves.toEqual({ updated: false });
  });

  it('audits denials and cannot authorize if the audit write fails', async () => {
    const membership = { accountId: 'a', tenantId: 'tenant-a', role: 'CLINIC_STAFF' as const, status: 'ACTIVE' as const };
    const audit = { calls: 0, async recordDenial() { this.calls += 1; } };
    await expect(authorizeTenant(membership, 'a', 'tenant-b', 'tenant.view', audit)).rejects.toThrow('FORBIDDEN');
    expect(audit.calls).toBe(1);
    await expect(authorizeTenant(membership, 'a', 'tenant-a', 'tenant.view', audit)).resolves.toBeUndefined();
    expect(audit.calls).toBe(1);
    await expect(authorizeTenant(membership, 'a', 'tenant-b', 'tenant.view', { recordDenial: async () => { throw new Error('AUDIT_FAILED'); } })).rejects.toThrow('AUDIT_FAILED');
  });
});

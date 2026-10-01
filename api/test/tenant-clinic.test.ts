import { TenantAccessError, TenantClinicService, type Clinic, type ClinicInput, type TenantRepository } from '../src/modules/tenants/tenants.js';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerClinicRoutes } from '../src/routes/clinics.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

class Repository implements TenantRepository {
  public clinics = new Map<string, Clinic>(); public transactions = 0;
  async transaction<T>(operation: Parameters<TenantRepository['transaction']>[0]) { this.transactions += 1; return operation({ query: async () => ({ rows: [] }) }) as T; }
  async activeAccount(accountId: string) { return accountId !== 'missing-account'; }
  async create(_db: unknown, _account: string, _ownerAccountId: string, input: ClinicInput) { const clinic = { id: `clinic-${this.clinics.size}`, tenantId: `tenant-${this.clinics.size}`, status: 'DRAFT' as const, legalName: input.legalName, displayName: input.displayName }; this.clinics.set(clinic.id, clinic); return clinic; }
  async find(id: string) { return this.clinics.get(id) ?? null; }
  async update(id: string, _account: string, input: ClinicInput) { const clinic = await this.find(id); if (!clinic) return null; const updated = { ...clinic, ...input }; this.clinics.set(id, updated); return updated; }
}
function setup() {
  const repository = new Repository(); const audit = { events: [] as unknown[], append: async (event: unknown) => { audit.events.push(event); } };
  const allowed = new Set<string>(); const context = { require: async (accountId: string, tenantId: string) => { if (!allowed.has(`${accountId}:${tenantId}`)) throw new Error('FORBIDDEN'); return { kind: 'TENANT_MEMBERSHIP' as const, membership: { id: 'membership', accountId, tenantId, role: 'CLINIC_OWNER' as const, status: 'ACTIVE' as const } }; }, isPlatformAdministrator: async (accountId: string) => accountId === 'platform-admin' };
  return { repository, audit, allowed, service: new TenantClinicService(repository, context as never, audit) };
}
describe('Step 6-8 clinic authorization transition', () => {
  it('disables legacy direct clinic creation for every authenticated role', async () => {
    const { service, repository } = setup();
    for (const accountId of ['ordinary-account', 'clinic-owner', 'clinic-admin', 'clinic-staff', 'doctor-account']) {
      await expect(service.create(accountId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(repository.transactions).toBe(0);
  });

  it('returns 403 from POST /v1/me/clinic for ordinary, clinic, and doctor sessions', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    const accounts = new Map(['ordinary', 'clinic-owner', 'clinic-admin', 'clinic-staff', 'doctor'].map((secret) => [hashSessionSecret(secret), secret]));
    const sessions: SessionAuthenticatorRepository = {
      findBySecretHash: async (hash) => {
        const accountId = accounts.get(hash);
        return accountId ? { id: `session-${accountId}`, accountId, status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null;
      },
      touch: async () => ({ updated: true }),
    };
    await registerClinicRoutes(app, { clinics: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });
    const payload = { legalName: 'Legal', displayName: 'Clinic' };
    for (const secret of ['ordinary', 'clinic-owner', 'clinic-admin', 'clinic-staff', 'doctor']) {
      expect((await app.inject({ method: 'POST', url: '/v1/me/clinic', headers: { cookie: `cliniq_session=session-${secret}.${secret}` }, payload })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/v1/me/clinic', payload })).statusCode).toBe(401);
    await app.close();
  });

  it('requires an active membership context for cross-account clinic reads and updates', async () => {
    const { service, repository, audit, allowed } = setup();
    const clinic = { id: 'clinic-a', tenantId: 'tenant-a', status: 'DRAFT' as const, legalName: 'Legal', displayName: 'Clinic' };
    repository.clinics.set(clinic.id, clinic); allowed.add(`account-a:${clinic.tenantId}`);
    await expect(service.read('account-a', clinic.id)).resolves.toEqual(clinic);
    await expect(service.read('account-b', clinic.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(service.update('account-b', clinic.id, { legalName: 'Other', displayName: 'Other' })).rejects.toBeInstanceOf(TenantAccessError);
    expect(audit.events).toHaveLength(2);
  });
  it('rejects unauthenticated creation', async () => { const { service } = setup(); await expect(service.create(undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' }); });
});

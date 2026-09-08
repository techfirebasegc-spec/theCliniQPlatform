import { TenantAccessError, TenantClinicService, type Clinic, type ClinicInput, type TenantRepository } from '../src/modules/tenants/tenants.js';
import { describe, expect, it } from 'vitest';

class Repository implements TenantRepository {
  public clinics = new Map<string, Clinic>(); public transactions = 0;
  async transaction<T>(operation: Parameters<TenantRepository['transaction']>[0]) { this.transactions += 1; return operation({ query: async () => ({ rows: [] }) }) as T; }
  async create(_db: unknown, _account: string, input: ClinicInput) { const clinic = { id: `clinic-${this.clinics.size}`, tenantId: `tenant-${this.clinics.size}`, status: 'DRAFT' as const, legalName: input.legalName, displayName: input.displayName }; this.clinics.set(clinic.id, clinic); return clinic; }
  async find(id: string) { return this.clinics.get(id) ?? null; }
  async update(id: string, _account: string, input: ClinicInput) { const clinic = await this.find(id); if (!clinic) return null; const updated = { ...clinic, ...input }; this.clinics.set(id, updated); return updated; }
}
function setup() {
  const repository = new Repository(); const audit = { events: [] as unknown[], append: async (event: unknown) => { audit.events.push(event); } };
  const allowed = new Set<string>(); const context = { require: async (accountId: string, tenantId: string) => { if (!allowed.has(`${accountId}:${tenantId}`)) throw new Error('FORBIDDEN'); return { id: 'membership', accountId, tenantId, role: 'CLINIC_OWNER' as const, status: 'ACTIVE' as const }; } };
  return { repository, audit, allowed, service: new TenantClinicService(repository, context as never, audit) };
}
describe('Step 6-8 clinic authorization transition', () => {
  it('creates a tenant and clinic atomically from the authenticated creator', async () => { const { service, repository } = setup(); const clinic = await service.create('account-a', { legalName: 'Legal', displayName: 'Clinic' }); expect(clinic.tenantId).toBeTruthy(); expect(repository.transactions).toBe(1); });
  it('requires an active membership context for cross-account clinic reads and updates', async () => { const { service, audit, allowed } = setup(); const clinic = await service.create('account-a', { legalName: 'Legal', displayName: 'Clinic' }); allowed.add(`account-a:${clinic.tenantId}`); await expect(service.read('account-a', clinic.id)).resolves.toEqual(clinic); await expect(service.read('account-b', clinic.id)).rejects.toBeInstanceOf(TenantAccessError); await expect(service.update('account-b', clinic.id, { legalName: 'Other', displayName: 'Other' })).rejects.toBeInstanceOf(TenantAccessError); expect(audit.events).toHaveLength(3); });
  it('rejects unauthenticated creation', async () => { const { service } = setup(); await expect(service.create(undefined, { legalName: 'Legal', displayName: 'Clinic' })).rejects.toBeInstanceOf(TenantAccessError); });
});

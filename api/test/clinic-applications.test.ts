import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, TransactionalAuditRepository } from '../src/modules/audit/audit.js';
import { ClinicApplicationService, type ClinicApplication, type ClinicApplicationInput, type ClinicApplicationRepository } from '../src/modules/clinic-applications/clinic-applications.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerClinicApplicationRoutes } from '../src/routes/clinic-applications.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

class Repository implements ClinicApplicationRepository {
  public application: ClinicApplication | null = null;
  public async transaction<T>(operation: (database: { query: never }) => Promise<T>) { return operation({ query: undefined as never }); }
  public async lockForApplicant(_database: unknown, accountId: string) { return this.application?.applicantAccountId === accountId ? this.application : null; }
  public async submit(_database: unknown, accountId: string, input: ClinicApplicationInput, existing: ClinicApplication | null) {
    const value = existing ?? { id: 'clinic-application', applicantAccountId: accountId, ...input, status: 'PENDING' as const, submittedAt: new Date(), reviewerAccountId: null, reviewedAt: null, rejectionReason: null };
    value.legalName = input.legalName; value.clinicName = input.clinicName; value.ownerEmail = input.ownerEmail; value.status = 'PENDING'; value.submittedAt = new Date(); value.reviewerAccountId = null; value.reviewedAt = null; value.rejectionReason = null; this.application = value;
    return value;
  }
  public async getForApplicant(accountId: string) { return this.application?.applicantAccountId === accountId ? this.application : null; }
  public async listPending() { return this.application?.status === 'PENDING' ? [this.application] : []; }
  public async getForReview(id: string) { return this.application?.id === id ? this.application : null; }
  public async lockForReview(_database: unknown, id: string) { return this.getForReview(id); }
  public async review(_database: unknown, application: ClinicApplication, reviewer: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    if (application.status !== 'PENDING') return null;
    application.status = outcome; application.reviewerAccountId = reviewer; application.reviewedAt = new Date(); application.rejectionReason = outcome === 'REJECTED' ? rejectionReason ?? null : null; return application;
  }
}

function setup() {
  const repository = new Repository(); const events: AuditEventInput[] = []; const onboarding: NewOnboarding[] = [];
  const audit: TransactionalAuditRepository = { append: async (event) => { events.push(event); }, appendInTransaction: async (_database, event) => { events.push(event); } };
  const service = new ClinicApplicationService(repository, { hasActiveEntitlement: async (account) => ['platform-admin', 'applicant'].includes(account) }, { createForPlatformAdminInTransaction: async (_database, actor, input) => { onboarding.push({ actor, ...input }); return { clinic: { id: 'clinic', tenantId: 'tenant', legalName: input.legalName, displayName: input.displayName, status: 'DRAFT' }, invitation: {} as never, secret: 'not-exposed' }; } }, audit);
  return { repository, events, onboarding, service };
}
type NewOnboarding = { actor: string; legalName: string; displayName: string; ownerEmail: string };
const input = (): ClinicApplicationInput => ({ legalName: 'Clinic Legal Name', clinicName: 'Clinic Name', ownerEmail: 'owner@example.com' });

describe('clinic application lifecycle', () => {
  it('creates only an application for the authenticated applicant and never creates clinic onboarding at submission', async () => {
    const { onboarding, events, service } = setup(); const submitted = await service.submit('applicant', input());
    expect(submitted).toMatchObject({ status: 'PENDING', applicantAccountId: 'applicant' }); expect(onboarding).toEqual([]);
    await expect(service.submit('applicant', input())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'CLINIC_APPLICATION_SUBMITTED', actorAccountId: 'applicant' }));
  });

  it('requires Platform Admin review, prevents self-review, and creates existing onboarding only on approval', async () => {
    const { events, onboarding, service } = setup(); const submitted = await service.submit('applicant', input());
    await expect(service.approve('clinic-owner', submitted.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.approve('applicant', submitted.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const approved = await service.approve('platform-admin', submitted.id);
    expect(approved.status).toBe('APPROVED');
    expect(onboarding).toEqual([{ actor: 'platform-admin', legalName: 'Clinic Legal Name', displayName: 'Clinic Name', ownerEmail: 'owner@example.com' }]);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'CLINIC_APPLICATION_APPROVED', actorAccountId: 'platform-admin', metadata: expect.objectContaining({ clinicId: 'clinic', tenantId: 'tenant' }) }));
  });

  it('stores rejection without onboarding and resubmits the same application record', async () => {
    const { onboarding, service } = setup(); const submitted = await service.submit('applicant', input());
    const rejected = await service.reject('platform-admin', submitted.id, 'Please correct the legal name.');
    expect(rejected.status).toBe('REJECTED'); expect(onboarding).toEqual([]);
    const resubmitted = await service.submit('applicant', { ...input(), clinicName: 'Updated Clinic Name' });
    expect(resubmitted).toMatchObject({ id: submitted.id, status: 'PENDING', clinicName: 'Updated Clinic Name', reviewerAccountId: null, reviewedAt: null, rejectionReason: null });
  });

  it('derives applicant and reviewer identity only from the session routes', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => { const accountId = hash === hashSessionSecret('applicant') ? 'applicant' : hash === hashSessionSecret('platform-admin') ? 'platform-admin' : undefined; return accountId ? { id: 'session', accountId, status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null; }, touch: async () => ({ updated: true }) };
    registerClinicApplicationRoutes(app, { applications: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });
    expect((await app.inject({ method: 'POST', url: '/v1/me/clinic-application', payload: input() })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/v1/me/clinic-application', headers: { cookie: 'cliniq_session=session.applicant' }, payload: input() }); expect(response.statusCode).toBe(201);
    const id = (response.json() as { application: { id: string } }).application.id;
    expect((await app.inject({ method: 'POST', url: `/v1/platform/clinic-applications/${id}/approve`, headers: { cookie: 'cliniq_session=session.applicant' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/platform/clinic-applications/${id}/approve`, headers: { cookie: 'cliniq_session=session.platform-admin' } })).statusCode).toBe(200);
    await app.close();
  });
});

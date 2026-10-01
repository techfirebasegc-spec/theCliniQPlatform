import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, TransactionalAuditRepository } from '../src/modules/audit/audit.js';
import { DoctorApplicationService, type DoctorApplication, type DoctorApplicationProfile, type DoctorApplicationRepository } from '../src/modules/doctor-applications/doctor-applications.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerDoctorApplicationRoutes } from '../src/routes/doctor-applications.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

class Repository implements DoctorApplicationRepository {
  public profile: DoctorApplicationProfile = { id: 'doctor-profile', accountId: 'doctor', status: 'DRAFT', professionalVerificationStatus: 'NOT_SUBMITTED' };
  public account = { id: 'doctor', status: 'PENDING_VERIFICATION' };
  public application: DoctorApplication | null = null;
  public async transaction<T>(operation: (database: { query: never }) => Promise<T>) { return operation({ query: undefined as never }); }
  public async lockOwnedProfile(_database: unknown, profileId: string, accountId: string) { return this.profile.id === profileId && this.profile.accountId === accountId ? this.profile : null; }
  public async lockApplicationForProfile(_database: unknown, profileId: string) { return this.application?.doctorProfileId === profileId ? this.application : null; }
  public async submit(_database: unknown, profile: DoctorApplicationProfile, _actor: string, existing: DoctorApplication | null) {
    const value = existing ?? { id: 'application-1', doctorProfileId: profile.id, doctorAccountId: profile.accountId, displayName: null, profileStatus: 'DRAFT', professionalVerificationStatus: 'NOT_SUBMITTED', status: 'PENDING' as const, submittedAt: new Date(), reviewedAt: null, reviewerAccountId: null, rejectionReason: null };
    value.status = 'PENDING'; value.submittedAt = new Date(); value.reviewedAt = null; value.reviewerAccountId = null; value.rejectionReason = null; value.profileStatus = 'PENDING_VERIFICATION'; value.professionalVerificationStatus = 'NOT_SUBMITTED';
    this.profile = { ...this.profile, status: 'PENDING_VERIFICATION', professionalVerificationStatus: 'NOT_SUBMITTED' }; this.application = value;
    return value;
  }
  public async getOwned(profileId: string, accountId: string) { return this.application?.doctorProfileId === profileId && accountId === this.profile.accountId ? this.application : null; }
  public async listPending() { return this.application?.status === 'PENDING' ? [this.application] : []; }
  public async getForReview(applicationId: string) { return this.application?.id === applicationId ? this.application : null; }
  public async lockForReview(_database: unknown, applicationId: string) { return this.getForReview(applicationId); }
  public async lockAccountForApproval(_database: unknown, accountId: string) { return this.account.id === accountId ? this.account : null; }
  public async activatePendingAccountForApproval(_database: unknown, accountId: string) { if (this.account.id !== accountId || this.account.status !== 'PENDING_VERIFICATION') return false; this.account.status = 'ACTIVE'; return true; }
  public async review(_database: unknown, application: DoctorApplication, reviewer: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    if (application.status !== 'PENDING') return null;
    application.status = outcome; application.reviewerAccountId = reviewer; application.reviewedAt = new Date(); application.rejectionReason = outcome === 'REJECTED' ? rejectionReason ?? null : null;
    if (outcome === 'APPROVED') { this.profile = { ...this.profile, status: 'ACTIVE' }; application.profileStatus = 'ACTIVE'; }
    return application;
  }
}

function setup() {
  const repository = new Repository(); const events: AuditEventInput[] = [];
  const audit: TransactionalAuditRepository = { append: async (event) => { events.push(event); }, appendInTransaction: async (_database, event) => { events.push(event); } };
  const service = new DoctorApplicationService(repository, { hasActiveEntitlement: async (account) => ['platform-admin', 'doctor'].includes(account) }, audit);
  return { repository, events, service };
}

describe('independent doctor application lifecycle', () => {
  it('moves only the authenticated doctor draft profile to PENDING_VERIFICATION without professional verification approval', async () => {
    const { repository, events, service } = setup();
    const application = await service.submit('doctor', 'doctor-profile');
    expect(application).toMatchObject({ status: 'PENDING', profileStatus: 'PENDING_VERIFICATION', professionalVerificationStatus: 'NOT_SUBMITTED' });
    expect(repository.profile).toMatchObject({ status: 'PENDING_VERIFICATION', professionalVerificationStatus: 'NOT_SUBMITTED' });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_APPLICATION_SUBMITTED', actorAccountId: 'doctor' }));
    await expect(service.submit('other', 'doctor-profile')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.submit('doctor', 'doctor-profile')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('requires a persisted Platform Admin, prevents self-review, and atomically activates the approved doctor profile and pending account', async () => {
    const { repository, events, service } = setup(); const application = await service.submit('doctor', 'doctor-profile');
    await expect(service.approve('clinic-owner', application.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.approve('doctor', application.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const approved = await service.approve('platform-admin', application.id);
    expect(approved).toMatchObject({ status: 'APPROVED', profileStatus: 'ACTIVE', professionalVerificationStatus: 'NOT_SUBMITTED' });
    expect(repository.profile).toMatchObject({ status: 'ACTIVE', professionalVerificationStatus: 'NOT_SUBMITTED' });
    expect(repository.account).toMatchObject({ status: 'ACTIVE' });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_APPLICATION_APPROVED', actorAccountId: 'platform-admin' }));
  });

  it('keeps a rejected application account and profile non-provider eligible and resubmits the same application record', async () => {
    const { repository, events, service } = setup(); const submitted = await service.submit('doctor', 'doctor-profile');
    expect(() => service.reject('platform-admin', submitted.id, '')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    const rejected = await service.reject('platform-admin', submitted.id, 'Please provide your registration details.');
    expect(rejected.status).toBe('REJECTED'); expect(repository.profile.status).toBe('PENDING_VERIFICATION'); expect(repository.account.status).toBe('PENDING_VERIFICATION');
    const resubmitted = await service.submit('doctor', 'doctor-profile');
    expect(resubmitted.id).toBe(submitted.id); expect(resubmitted).toMatchObject({ status: 'PENDING', reviewedAt: null, reviewerAccountId: null, rejectionReason: null });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_APPLICATION_REJECTED' }));
  });

  it('approves an application for an already active account without changing its account state', async () => {
    const { repository, service } = setup(); repository.account.status = 'ACTIVE';
    const application = await service.submit('doctor', 'doctor-profile');
    await service.approve('platform-admin', application.id);
    expect(repository.account.status).toBe('ACTIVE');
    expect(repository.profile.status).toBe('ACTIVE');
  });

  it('rejects an unexpected account state before activating the doctor profile', async () => {
    const { repository, service } = setup(); repository.account.status = 'SUSPENDED';
    const application = await service.submit('doctor', 'doctor-profile');
    await expect(service.approve('platform-admin', application.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repository.account.status).toBe('SUSPENDED');
    expect(repository.profile.status).toBe('PENDING_VERIFICATION');
    expect(repository.application?.status).toBe('PENDING');
  });

  it('derives actor identity from the session for the doctor and Platform Admin routes', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => {
      const accountId = hash === hashSessionSecret('doctor') ? 'doctor' : hash === hashSessionSecret('platform-admin') ? 'platform-admin' : undefined;
      return accountId ? { id: 'session', accountId, status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null;
    }, touch: async () => ({ updated: true }) };
    registerDoctorApplicationRoutes(app, { applications: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });
    expect((await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-profile/application' })).statusCode).toBe(401);
    const submitted = await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-profile/application', headers: { cookie: 'cliniq_session=session.doctor' } });
    expect(submitted.statusCode).toBe(201);
    const body = submitted.json() as { application: { id: string } };
    expect((await app.inject({ method: 'POST', url: `/v1/platform/doctor-applications/${body.application.id}/approve`, headers: { cookie: 'cliniq_session=session.doctor' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/platform/doctor-applications/${body.application.id}/approve`, headers: { cookie: 'cliniq_session=session.platform-admin' } })).statusCode).toBe(200);
    await app.close();
  });
});

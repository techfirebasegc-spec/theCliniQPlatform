import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, TransactionalAuditRepository } from '../src/modules/audit/audit.js';
import { DoctorVerificationService, type DoctorVerificationRepository, type DoctorVerificationSubmission, type DoctorVerificationSubmissionInput } from '../src/modules/doctor-verification/doctor-verification.js';
import { PostgresDoctorVerificationRepository } from '../src/modules/doctor-verification/postgres-doctor-verification-repository.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerDoctorVerificationRoutes } from '../src/routes/doctor-verification.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

type Profile = { id: string; accountId: string; status: string; professionalVerificationStatus: string };
class Repository implements DoctorVerificationRepository {
  public profile: Profile = { id: 'doctor-profile', accountId: 'doctor', status: 'ACTIVE', professionalVerificationStatus: 'NOT_SUBMITTED' };
  public submissions = new Map<string, DoctorVerificationSubmission>();
  public async transaction<T>(operation: (database: { query: never }) => Promise<T>) { return operation({ query: undefined as never }); }
  public async lockOwnedDoctorProfile(_database: unknown, profileId: string, accountId: string) { return this.profile.id === profileId && this.profile.accountId === accountId ? this.profile : null; }
  public async findPendingSubmission(_database: unknown, profileId: string) { return [...this.submissions.values()].find((item) => item.doctorProfileId === profileId && item.status === 'PENDING') ?? null; }
  public async savePendingSubmission(_database: unknown, _actor: string, profile: Profile, input: DoctorVerificationSubmissionInput, existing: DoctorVerificationSubmission | null) {
    const value: DoctorVerificationSubmission = existing ?? { id: `submission-${this.submissions.size + 1}`, doctorProfileId: profile.id, doctorAccountId: profile.accountId, registrationAuthority: '', registrationJurisdiction: '', registrationIdentifier: '', status: 'PENDING', submittedAt: new Date(), reviewedByAccountId: null, reviewedAt: null, rejectionReason: null, documentFileIds: [] };
    value.registrationAuthority = input.registrationAuthority.trim(); value.registrationJurisdiction = input.registrationJurisdiction.trim(); value.registrationIdentifier = input.registrationIdentifier.trim(); value.documentFileIds = input.documentFileIds; value.status = 'PENDING'; value.submittedAt = new Date(); value.reviewedByAccountId = null; value.reviewedAt = null; value.rejectionReason = null;
    this.submissions.set(value.id, value); this.profile = { ...this.profile, status: 'ACTIVE', professionalVerificationStatus: 'PENDING' };
    return value;
  }
  public async listSubmissionsForDoctor(profileId: string, accountId: string) { return this.profile.id === profileId && this.profile.accountId === accountId ? [...this.submissions.values()] : null; }
  public async listSubmissionsForReview(profileId: string) { return this.profile.id === profileId ? [...this.submissions.values()] : null; }
  public async lockSubmission(_database: unknown, submissionId: string) { return this.submissions.get(submissionId) ?? null; }
  public async reviewSubmission(_database: unknown, submission: DoctorVerificationSubmission, reviewer: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    if (submission.status !== 'PENDING') return null;
    submission.status = outcome; submission.reviewedByAccountId = reviewer; submission.reviewedAt = new Date(); submission.rejectionReason = outcome === 'REJECTED' ? rejectionReason ?? null : null;
    this.profile = { ...this.profile, status: 'ACTIVE', professionalVerificationStatus: outcome === 'APPROVED' ? 'VERIFIED' : 'REJECTED' };
    return submission;
  }
}

function setup() {
  const repository = new Repository(); const events: AuditEventInput[] = [];
  const audit: TransactionalAuditRepository = { append: async (event) => { events.push(event); }, appendInTransaction: async (_database, event) => { events.push(event); } };
  return { repository, events, service: new DoctorVerificationService(repository, { hasActiveEntitlement: async (accountId) => ['platform-admin', 'doctor'].includes(accountId) }, audit) };
}
const submission = () => ({ registrationAuthority: 'Medical Council', registrationJurisdiction: 'Karnataka', registrationIdentifier: 'REG-123', documentFileIds: ['file-1'] });

describe('doctor professional verification lifecycle', () => {
  it('places verification-submission ordering after grouping in the PostgreSQL list query', async () => {
    const queries: string[] = [];
    const repository = new PostgresDoctorVerificationRepository({
      query: async <T extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        return { rows: text.startsWith('SELECT 1') ? [{} as T] : [] };
      },
      transaction: async () => { throw new Error('unused'); },
    });

    await repository.listSubmissionsForDoctor('doctor-profile', 'doctor');

    const listQuery = queries.at(-1) ?? '';
    expect(listQuery).toMatch(/GROUP BY submission\.id,doctor\.account_id ORDER BY submission\.submitted_at DESC/);
    expect(listQuery).not.toMatch(/WHERE submission\.doctor_profile_id=\$1 ORDER BY[\s\S]*GROUP BY/);
  });

  it('submits only an application-approved doctor profile and atomically enters ACTIVE/PENDING', async () => {
    const { repository, events, service } = setup();
    const created = await service.submit('doctor', 'doctor-profile', submission());
    expect(created.status).toBe('PENDING'); expect(repository.profile).toMatchObject({ status: 'ACTIVE', professionalVerificationStatus: 'PENDING' });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_VERIFICATION_SUBMITTED', actorAccountId: 'doctor', outcome: 'SUCCESS' }));
    await expect(service.submit('other', 'doctor-profile', submission())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a persisted Platform Admin reviewer and prevents self-approval', async () => {
    const { repository, events, service } = setup(); const created = await service.submit('doctor', 'doctor-profile', submission());
    await expect(service.approve('doctor', created.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.approve('clinic-owner', created.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const approved = await service.approve('platform-admin', created.id);
    expect(approved.status).toBe('APPROVED'); expect(repository.profile).toMatchObject({ status: 'ACTIVE', professionalVerificationStatus: 'VERIFIED' });
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_PROFESSIONAL_VERIFICATION_APPROVED', actorAccountId: 'platform-admin', outcome: 'SUCCESS' }));
  });

  it('records rejection and permits a controlled resubmission without replacing the doctor profile', async () => {
    const { repository, events, service } = setup(); const created = await service.submit('doctor', 'doctor-profile', submission());
    await expect(service.reject('platform-admin', created.id, '')).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.reject('platform-admin', created.id, 'Registration identifier is unreadable.');
    expect(repository.profile).toMatchObject({ status: 'ACTIVE', professionalVerificationStatus: 'REJECTED' });
    const resubmitted = await service.submit('doctor', 'doctor-profile', { ...submission(), documentFileIds: ['file-2'] });
    expect(resubmitted.id).not.toBe(created.id); expect(repository.profile.professionalVerificationStatus).toBe('PENDING');
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'DOCTOR_PROFESSIONAL_VERIFICATION_REJECTED', outcome: 'SUCCESS' }));
  });

  it('maps session-derived routes and keeps submission data inaccessible to another account', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('doctor') ? { id: 'session', accountId: 'doctor', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) };
    registerDoctorVerificationRoutes(app, { verification: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });
    expect((await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-profile/verification-submissions', payload: submission() })).statusCode).toBe(401);
    const created = await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-profile/verification-submissions', headers: { cookie: 'cliniq_session=session.doctor' }, payload: submission() });
    expect(created.statusCode).toBe(201);
    const forbidden = await app.inject({ method: 'GET', url: '/v1/me/doctor-profiles/other-profile/verification-submissions', headers: { cookie: 'cliniq_session=session.doctor' } });
    expect(forbidden.statusCode).toBe(403); await app.close();
  });
});

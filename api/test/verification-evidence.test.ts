import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { TransactionalAuditRepository } from '../src/modules/audit/audit.js';
import type { StorageProvider } from '../src/modules/files/aic-s3-storage-provider.js';
import { DoctorVerificationError } from '../src/modules/doctor-verification/doctor-verification.js';
import type { VerificationEvidenceRepository } from '../src/modules/doctor-verification/verification-evidence.js';
import { VerificationEvidenceService } from '../src/modules/doctor-verification/verification-evidence.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerDoctorVerificationEvidenceRoutes } from '../src/routes/doctor-verification-evidence.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

type Evidence = { id: string; doctorProfileId: string; doctorAccountId: string; originalFilename: string; contentType: string; byteSize: number; status: 'AVAILABLE'; objectKey: string; bucket: string };
class Repository implements VerificationEvidenceRepository {
  public evidence: Evidence[] = [];
  public async transaction<T>(operation: (database: { query: never }) => Promise<T>) { return operation({ query: undefined as never }); }
  public async createPending(_db: unknown, value: Evidence) { if (value.doctorProfileId !== 'doctor-a' || value.doctorAccountId !== 'doctor-a-account') throw new Error('DOCTOR_VERIFICATION_PROFILE_NOT_OWNED'); this.evidence.push({ ...value, status: 'AVAILABLE' }); }
  public async markAvailable() {}
  public async markUploadFailed() {}
  public async listOwned(profileId: string, accountId: string) { return profileId === 'doctor-a' && accountId === 'doctor-a-account' ? this.evidence.filter((item) => item.doctorProfileId === profileId) : null; }
  public async findOwned(fileId: string, profileId: string, accountId: string) { return this.evidence.find((item) => item.id === fileId && item.doctorProfileId === profileId && item.doctorAccountId === accountId) ?? null; }
  public async listForReview(submissionId: string) { return submissionId === 'submission-a' ? this.evidence.filter((item) => item.doctorProfileId === 'doctor-a') : null; }
  public async findForReview(submissionId: string, fileId: string) { return submissionId === 'submission-a' ? this.evidence.find((item) => item.id === fileId) ?? null : null; }
}
class Storage implements StorageProvider {
  public objects = new Map<string, Uint8Array>();
  public async putObject(key: string, body: Uint8Array) { this.objects.set(key, body); }
  public async headObject() { return { contentLength: null, contentType: null, metadata: {} }; }
  public async getObject(key: string) { const body = this.objects.get(key); if (!body) throw new Error('MISSING'); return { body, contentLength: body.byteLength, contentType: 'application/pdf', metadata: {} }; }
  public async deleteObject() {}
}
function setup() { const repository = new Repository(); const storage = new Storage(); const events: string[] = []; const audit: TransactionalAuditRepository = { append: async (event) => { events.push(event.eventType); }, appendInTransaction: async (_db, event) => { events.push(event.eventType); } }; return { repository, storage, events, service: new VerificationEvidenceService(repository, storage, 'private-bucket', { hasActiveEntitlement: async (accountId) => accountId === 'platform-admin' || accountId === 'doctor-a-account' }, audit) }; }
const upload = () => ({ originalFilename: 'registration.pdf', contentType: 'application/pdf', body: new Uint8Array([1, 2, 3]) });

describe('private doctor verification evidence', () => {
  it('allows only the owning doctor to upload and retrieve private evidence', async () => {
    const { events, service } = setup(); const evidence = await service.upload('doctor-a-account', 'doctor-a', upload());
    expect(evidence).not.toHaveProperty('objectKey'); expect(evidence).not.toHaveProperty('doctorAccountId');
    await expect(service.downloadForDoctor('doctor-a-account', 'doctor-a', evidence.id)).resolves.toMatchObject({ evidence: { originalFilename: 'registration.pdf' } });
    await expect(service.downloadForDoctor('doctor-b-account', 'doctor-a', evidence.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(events).toContain('DOCTOR_VERIFICATION_EVIDENCE_UPLOADED');
  });

  it('permits only a non-self Platform Admin reviewer to view submitted evidence', async () => {
    const { service } = setup(); const evidence = await service.upload('doctor-a-account', 'doctor-a', upload());
    await expect(service.downloadForReviewer('clinic-owner', 'submission-a', evidence.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.downloadForReviewer('doctor-a-account', 'submission-a', evidence.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.downloadForReviewer('platform-admin', 'submission-a', evidence.id)).resolves.toMatchObject({ evidence: { id: evidence.id } });
    await expect(service.downloadForReviewer('platform-admin', 'submission-b', evidence.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires an authenticated session at the evidence route', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('doctor') ? { id: 'session', accountId: 'doctor-a-account', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) };
    registerDoctorVerificationEvidenceRoutes(app, { evidence: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });
    const body = Buffer.from([1, 2, 3]).toString('base64');
    expect((await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-a/verification-evidence', payload: { originalFilename: 'registration.pdf', contentType: 'application/pdf', contentBase64: body } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/me/doctor-profiles/doctor-a/verification-evidence', headers: { cookie: 'cliniq_session=session.doctor' }, payload: { originalFilename: 'registration.pdf', contentType: 'application/pdf', contentBase64: body } })).statusCode).toBe(201);
    await app.close();
  });
});

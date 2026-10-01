import type { FastifyInstance } from 'fastify';
import { DoctorVerificationError, type DoctorVerificationService } from '../modules/doctor-verification/doctor-verification.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export function registerDoctorVerificationRoutes(app: FastifyInstance, dependencies: { verification: DoctorVerificationService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  app.post('/v1/me/doctor-profiles/:doctorProfileId/verification-submissions', async (request, reply) => reply.code(201).send({ submission: await dependencies.verification.submit(await account(request.headers.cookie, dependencies), id(request, 'doctorProfileId'), submissionInput(request.body)) }));
  app.get('/v1/me/doctor-profiles/:doctorProfileId/verification-submissions', async (request) => ({ items: await dependencies.verification.submissionsForDoctor(await account(request.headers.cookie, dependencies), id(request, 'doctorProfileId')) }));
  app.get('/v1/platform/doctors/:doctorId/verification-submissions', async (request) => ({ items: await dependencies.verification.submissionsForReview(await account(request.headers.cookie, dependencies), id(request, 'doctorId')) }));
  app.post('/v1/platform/doctor-verification-submissions/:submissionId/approve', async (request) => ({ submission: await dependencies.verification.approve(await account(request.headers.cookie, dependencies), id(request, 'submissionId')) }));
  app.post('/v1/platform/doctor-verification-submissions/:submissionId/reject', async (request) => ({ submission: await dependencies.verification.reject(await account(request.headers.cookie, dependencies), id(request, 'submissionId'), rejectionReason(request.body)) }));
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  try { return (await authenticateSession(cookie(header, sessionCookieName), dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new DoctorVerificationError('UNAUTHORIZED'); }
}
function cookie(header: string | undefined, name: string) { return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function id(request: { params: unknown }, key: string) { const value = (request.params as Record<string, unknown>)[key]; if (typeof value !== 'string' || !value.trim()) throw new DoctorVerificationError('CONFLICT'); return value; }
function submissionInput(value: unknown) {
  if (typeof value !== 'object' || value === null) throw new DoctorVerificationError('CONFLICT');
  const input = value as Record<string, unknown>;
  if (typeof input.registrationAuthority !== 'string' || typeof input.registrationJurisdiction !== 'string' || typeof input.registrationIdentifier !== 'string' || !Array.isArray(input.documentFileIds) || input.documentFileIds.some((fileId) => typeof fileId !== 'string')) throw new DoctorVerificationError('CONFLICT');
  return { registrationAuthority: input.registrationAuthority, registrationJurisdiction: input.registrationJurisdiction, registrationIdentifier: input.registrationIdentifier, documentFileIds: input.documentFileIds as string[] };
}
function rejectionReason(value: unknown) { if (typeof value !== 'object' || value === null || typeof (value as { rejectionReason?: unknown }).rejectionReason !== 'string') throw new DoctorVerificationError('CONFLICT'); return (value as { rejectionReason: string }).rejectionReason; }

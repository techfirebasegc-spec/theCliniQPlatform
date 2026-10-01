import type { FastifyInstance } from 'fastify';
import { ClinicServiceDoctorAssignmentError, type ClinicServiceDoctorAssignmentService } from '../modules/clinic-service-doctors/clinic-service-doctors.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export async function registerClinicServiceDoctorAssignmentRoutes(app: FastifyInstance, dependencies: { assignments: ClinicServiceDoctorAssignmentService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  app.get('/v1/me/clinic/services/:serviceOfferingId/doctors', async (request) => ({ items: await dependencies.assignments.list(await account(request.headers.cookie, dependencies), id(request, 'serviceOfferingId')) }));
  app.post('/v1/me/clinic/services/:serviceOfferingId/doctors', async (request, reply) => reply.code(201).send({ assignment: await dependencies.assignments.create(await account(request.headers.cookie, dependencies), id(request, 'serviceOfferingId'), doctor(request.body)) }));
  app.delete('/v1/me/clinic/services/:serviceOfferingId/doctors/:doctorProfileId', async (request) => ({ assignment: await dependencies.assignments.revoke(await account(request.headers.cookie, dependencies), id(request, 'serviceOfferingId'), id(request, 'doctorProfileId')) }));
}
async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new ClinicServiceDoctorAssignmentError('UNAUTHORIZED'); } }
function id(request: { params: unknown }, key: string) { const value = (request.params as Record<string, unknown>)[key]; if (typeof value !== 'string' || !value) throw new ClinicServiceDoctorAssignmentError('CONFLICT'); return value; }
function doctor(value: unknown) { const doctorProfileId = (value as { doctorProfileId?: unknown })?.doctorProfileId; if (typeof doctorProfileId !== 'string' || !doctorProfileId) throw new ClinicServiceDoctorAssignmentError('CONFLICT'); return doctorProfileId; }

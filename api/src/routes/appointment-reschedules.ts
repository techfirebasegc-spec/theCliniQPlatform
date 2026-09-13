import type { FastifyInstance } from 'fastify';
import { RescheduleError, type RescheduleService } from '../modules/appointments/rescheduling.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export async function registerAppointmentRescheduleRoutes(app: FastifyInstance, dependencies: { reschedules: RescheduleService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.post('/v1/appointments/:appointmentId/reschedules', async (request, reply) => {
    const body=request.body as Record<string,unknown>;
    if(!body || Object.keys(body).some(k=>!['requestedLocalAt','reason','idempotencyKey'].includes(k)) || typeof body.requestedLocalAt!=='string'||typeof body.reason!=='string'||typeof body.idempotencyKey!=='string') throw new RescheduleError('CONFLICT');
    const result=await dependencies.reschedules.reschedule(await account(request.headers.cookie,dependencies),(request.params as {appointmentId:string}).appointmentId,{requestedLocalAt:body.requestedLocalAt,reason:body.reason,idempotencyKey:body.idempotencyKey});
    return reply.code(result.replayed?200:201).send(result);
  });
}
async function account(header:string|undefined,d:{sessions:SessionAuthenticatorRepository;sessionPolicy:SessionPolicy}){try{const value=header?.split(';').map(p=>p.trim()).find(p=>p.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length+1);return (await authenticateSession(value,d.sessionPolicy,d.sessions)).accountId;}catch{throw new RescheduleError('UNAUTHORIZED');}}

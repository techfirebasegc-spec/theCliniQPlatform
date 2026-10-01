import type { FastifyInstance } from 'fastify';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';
import { ProviderPortalError, type ProviderPortalService } from '../modules/provider-portal/provider-portal.js';

export function registerProviderPortalRoutes(app: FastifyInstance, dependencies: { portal: ProviderPortalService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  app.get('/v1/provider/context', async (request) => dependencies.portal.contextFor(await account(request.headers.cookie, dependencies)));
  app.get('/v1/provider/clinics/:clinicId/dashboard', async (request) => dependencies.portal.clinicDashboard(await account(request.headers.cookie, dependencies), id(request)));
  app.get('/v1/provider/clinics/:clinicId/services', async (request) => ({ items: await dependencies.portal.clinicServices(await account(request.headers.cookie, dependencies), id(request)) }));
  app.get('/v1/provider/clinics/:clinicId/doctors', async (request) => ({ items: await dependencies.portal.clinicDoctors(await account(request.headers.cookie, dependencies), id(request)) }));
  app.get('/v1/provider/clinics/:clinicId/appointments', async (request) => ({ items: await dependencies.portal.clinicAppointments(await account(request.headers.cookie, dependencies), id(request)) }));
  app.get('/v1/provider/doctor/services', async (request) => ({ items: await dependencies.portal.doctorServices(await account(request.headers.cookie, dependencies)) }));
  app.get('/v1/provider/doctor/appointments', async (request) => ({ items: await dependencies.portal.doctorAppointments(await account(request.headers.cookie, dependencies)) }));
}
function id(request:{params:unknown}) { const value=(request.params as {clinicId?:unknown}).clinicId; if(typeof value!=='string') throw new ProviderPortalError('FORBIDDEN'); return value; }
async function account(header:string|undefined, dependencies:{sessions:SessionAuthenticatorRepository;sessionPolicy:SessionPolicy}) { try { const value=header?.split(';').map((part)=>part.trim()).find((part)=>part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length+1); return (await authenticateSession(value,dependencies.sessionPolicy,dependencies.sessions)).accountId; } catch { throw new ProviderPortalError('UNAUTHORIZED'); } }

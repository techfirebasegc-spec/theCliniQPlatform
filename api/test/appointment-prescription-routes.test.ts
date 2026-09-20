import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { PrescriptionError, type AppointmentPrescriptionService } from '../src/modules/prescriptions/appointment-prescriptions.js';
import { registerAppointmentPrescriptionRoutes } from '../src/routes/appointment-prescriptions.js';
import type { SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

function app() {
  const prescriptions = { create: async () => { throw new PrescriptionError('FORBIDDEN'); }, get: async () => { throw new PrescriptionError('NOT_FOUND'); }, update: async () => { throw new PrescriptionError('CONFLICT'); }, issue: async () => { throw new PrescriptionError('CONFLICT'); } } as unknown as AppointmentPrescriptionService;
  const sessions: SessionAuthenticatorRepository = { findBySecretHash: async () => ({ id: 'session', accountId: 'doctor', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-02') }), touch: async () => ({ updated: true }) };
  const value = Fastify(); registerErrorHandler(value); void value.register(async (instance) => registerAppointmentPrescriptionRoutes(instance, { prescriptions, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } })); return value;
}
describe('appointment prescription routes', () => {
  it('maps unauthenticated, forbidden, not-found, and conflict errors', async () => { const value = app(); const authenticated = { cookie: 'cliniq_session=session.any' }; expect((await value.inject({ method: 'POST', url: '/v1/appointments/a/prescription', payload: { idempotencyKey: 'k' } })).statusCode).toBe(401); expect((await value.inject({ method: 'POST', url: '/v1/appointments/a/prescription', headers: authenticated, payload: { idempotencyKey: 'k' } })).statusCode).toBe(403); expect((await value.inject({ method: 'GET', url: '/v1/appointments/a/prescription', headers: authenticated })).statusCode).toBe(404); expect((await value.inject({ method: 'PATCH', url: '/v1/appointments/a/prescription', headers: authenticated, payload: { expectedDraftVersion: 1, items: [] } })).statusCode).toBe(409); await value.close(); });
});

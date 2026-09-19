import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { type DelegatedBookingService } from '../src/modules/appointments/delegated-bookings.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerDelegatedBookingRoutes } from '../src/routes/delegated-bookings.js';

describe('Phase 5.8 delegated booking routes', () => {
  it('keeps authorization consumption internal to the delegated fixed-slot booking route', async () => {
    const calls: unknown[][] = []; const bookings = {
      authorize: async (...args: unknown[]) => { calls.push(['authorize', ...args]); return { id: 'authorization-a' }; },
      revoke: async (...args: unknown[]) => { calls.push(['revoke', ...args]); },
      book: async (...args: unknown[]) => { calls.push(['book', ...args]); return { appointmentIntentId: 'intent-a', slotReservationId: 'reservation-a', networkBookingContextId: 'context-a' }; },
    } as unknown as DelegatedBookingService;
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('secret') ? { id: 's', accountId: 'patient-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) };
    const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerDelegatedBookingRoutes(instance, { bookings, sessions, sessionPolicy: { idleTtlSeconds: 60, absoluteTtlSeconds: 3600 } }));
    const headers = { cookie: 'cliniq_session=s.secret' };
    expect((await app.inject({ method: 'POST', url: '/v1/delegated-booking-authorizations', headers, payload: { delegatedClinicId: 'clinic-a', serviceExposureId: 'exposure-a', approvedStartsAt: '2031-01-01T10:00:00Z', approvedEndsAt: '2031-01-01T10:30:00Z' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/v1/delegated-bookings', headers, payload: { authorizationId: 'authorization-a', idempotencyKey: 'booking-a' } })).statusCode).toBe(201);
    expect(calls).toEqual([['authorize', 'patient-a', { delegatedClinicId: 'clinic-a', serviceExposureId: 'exposure-a', approvedStartsAt: '2031-01-01T10:00:00Z', approvedEndsAt: '2031-01-01T10:30:00Z' }], ['book', 'patient-a', { authorizationId: 'authorization-a', idempotencyKey: 'booking-a' }]]);
    await app.close();
  });
});

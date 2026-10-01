import type { FastifyInstance } from 'fastify';
import { AdminReadError, type AdminReadService, type AppointmentListFilter, type Page } from '../modules/admin-read/admin-read.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

const appointmentStatuses = new Set(['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED']);

export async function registerAdminReadRoutes(app: FastifyInstance, dependencies: { reads: AdminReadService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.get('/v1/admin/context', async (request) => ({ items: await dependencies.reads.contexts(await account(request.headers.cookie, dependencies)) }));
  app.get('/v1/admin/tenants/:tenantId/memberships', async (request) => dependencies.reads.memberships(await account(request.headers.cookie, dependencies), tenantId(request), page(request.query)));
  app.get('/v1/admin/tenants/:tenantId/appointments', async (request) => dependencies.reads.appointments(await account(request.headers.cookie, dependencies), tenantId(request), appointmentFilter(request.query)));
  app.get('/v1/admin/tenants/:tenantId/services', async (request) => dependencies.reads.services(await account(request.headers.cookie, dependencies), tenantId(request), page(request.query)));
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new AdminReadError('UNAUTHORIZED'); } }
function tenantId(request: { params: unknown }): string { const value = (request.params as { tenantId?: unknown }).tenantId; if (typeof value !== 'string' || !value.trim()) throw new AdminReadError('CONFLICT'); return value; }
function page(value: unknown): Page { const query = value as { limit?: unknown; offset?: unknown }; const limit = query?.limit === undefined ? 25 : integer(query.limit); const offset = query?.offset === undefined ? 0 : integer(query.offset); if (limit === null || offset === null || limit < 1 || limit > 100 || offset < 0) throw new AdminReadError('CONFLICT'); return { limit, offset }; }
function appointmentFilter(value: unknown): AppointmentListFilter { const result = page(value); const query = value as { from?: unknown; to?: unknown; status?: unknown }; const from = date(query?.from); const to = date(query?.to); if ((query?.from !== undefined && !from) || (query?.to !== undefined && !to) || (from && to && from >= to) || (query?.status !== undefined && (typeof query.status !== 'string' || !appointmentStatuses.has(query.status)))) throw new AdminReadError('CONFLICT'); return { ...result, from, to, status: query?.status as string | undefined }; }
function integer(value: unknown): number | null { return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null; }
function date(value: unknown): Date | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return undefined; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? undefined : parsed; }

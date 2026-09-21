import type { FastifyInstance } from 'fastify';
import { PublicDiscoveryError, type PublicDiscoveryService } from '../modules/discovery/public-discovery.js';

export async function registerPublicDiscoveryRoutes(app: FastifyInstance, dependencies: { discovery: PublicDiscoveryService }): Promise<void> {
  app.get('/v1/public/doctors', async (request) => ({ items: await dependencies.discovery.doctors(query(request).q) }));
  app.get('/v1/public/doctors/:doctorProfileId', async (request) => dependencies.discovery.doctor((request.params as { doctorProfileId?: string }).doctorProfileId ?? ''));
  app.get('/v1/public/service-exposures', async (request) => ({ items: await dependencies.discovery.services({ doctorProfileId: query(request).doctorProfileId, query: query(request).q }) }));
  app.get('/v1/public/service-exposures/:exposureId/availability', async (request) => {
    const date = query(request).date; if (!date) throw new PublicDiscoveryError('CONFLICT');
    return dependencies.discovery.availability((request.params as { exposureId?: string }).exposureId ?? '', date);
  });
}
function query(request: { query: unknown }): { q?: string; doctorProfileId?: string; date?: string } { const value = request.query as Record<string, unknown>; return { q: typeof value.q === 'string' ? value.q : undefined, doctorProfileId: typeof value.doctorProfileId === 'string' ? value.doctorProfileId : undefined, date: typeof value.date === 'string' ? value.date : undefined }; }

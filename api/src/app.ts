import type { Environment } from './config/environment.js';
import { createDatabase, type DatabaseHealth } from './infrastructure/database.js';
import { createRedis, type RedisHealth } from './infrastructure/redis.js';
import { registerErrorHandler } from './middleware/errors.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerClinicRoutes } from './routes/clinics.js';
import { registerMembershipRoutes } from './routes/memberships.js';
import { PostgresAuditRepository } from './modules/audit/postgres-audit-repository.js';
import { PostgresProfileRepository } from './modules/profiles/postgres-profile-repository.js';
import { ProfileService } from './modules/profiles/profiles.js';
import { PostgresSessionRepository } from './modules/sessions/postgres-session-repository.js';
import { PostgresTenantRepository } from './modules/tenants/postgres-tenant-repository.js';
import { TenantClinicService } from './modules/tenants/tenants.js';
import { PostgresMembershipRepository } from './modules/memberships/postgres-membership-repository.js';
import { MembershipService, TenantContextService } from './modules/memberships/memberships.js';
import { PostgresNetworkRepository } from './modules/network/postgres-network-repository.js';
import { NetworkService } from './modules/network/network.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerServiceOfferingRoutes } from './routes/service-offerings.js';
import { PostgresServiceOfferingRepository } from './modules/service-offerings/postgres-service-offering-repository.js';
import { ServiceOfferingService } from './modules/service-offerings/service-offerings.js';
import { registerAvailabilityRoutes } from './routes/availability.js';
import { PostgresAvailabilityRepository } from './modules/availability/postgres-availability-repository.js';
import { AvailabilityService } from './modules/availability/availability.js';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';

export interface AppDependencies {
  database: DatabaseHealth;
  redis: RedisHealth;
}

export function createApp(environment: Environment, dependencies?: AppDependencies) {
  const app = Fastify({
    logger: { level: environment.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization'] },
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
  });
  const services = dependencies ?? { database: createDatabase(environment), redis: createRedis(environment) };

  void app.register(helmet);
  void app.register(cors, { origin: environment.WEB_URL, credentials: true });
  registerErrorHandler(app);
  void app.register(async (instance) => registerStatusRoutes(instance, services));
  void app.register(async (instance) => registerProfileRoutes(instance, {
    profiles: new ProfileService(new PostgresProfileRepository(services.database), new PostgresAuditRepository(services.database)),
    sessions: new PostgresSessionRepository(services.database),
    sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  const audit = new PostgresAuditRepository(services.database);
  const memberships = new PostgresMembershipRepository(services.database);
  const context = new TenantContextService(memberships, audit);
  void app.register(async (instance) => registerClinicRoutes(instance, { clinics: new TenantClinicService(new PostgresTenantRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerMembershipRoutes(instance, { memberships: new MembershipService(memberships, context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerNetworkRoutes(instance, { network: new NetworkService(new PostgresNetworkRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerServiceOfferingRoutes(instance, { offerings: new ServiceOfferingService(new PostgresServiceOfferingRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerAvailabilityRoutes(instance, { availability: new AvailabilityService(new PostgresAvailabilityRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));

  return { app, services };
}

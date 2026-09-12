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
import { AppointmentService } from './modules/appointments/appointments.js';
import { PostgresAppointmentRepository } from './modules/appointments/postgres-appointment-repository.js';
import { registerAppointmentIntentRoutes } from './routes/appointment-intents.js';
import { registerServiceExposureRoutes } from './routes/service-exposures.js';
import { PostgresServiceExposureRepository } from './modules/service-exposures/postgres-service-exposure-repository.js';
import { ServiceExposureService } from './modules/service-exposures/service-exposures.js';
import { PaymentHandoffService } from './modules/appointments/payment-handoffs.js';
import { PostgresPaymentHandoffRepository } from './modules/appointments/postgres-payment-handoff-repository.js';
import { resolvePaymentProviderKey } from './modules/financial/provider-registry.js';
import { RazorpayPaymentProvider } from './modules/financial/provider.js';
import { PaymentOrderProvisioningService } from './modules/appointments/payment-order-provisioning.js';
import { PostgresPaymentOrderProvisioningRepository } from './modules/appointments/postgres-payment-order-provisioning-repository.js';
import { PaymentConfirmationService } from './modules/appointments/payment-confirmation.js';
import { PostgresPaymentConfirmationRepository } from './modules/appointments/postgres-payment-confirmation-repository.js';
import { registerRazorpayWebhookRoutes } from './routes/razorpay-webhooks.js';
import { registerAppointmentCancellationRoutes } from './routes/appointment-cancellations.js';
import { AppointmentAuthorizationService } from './modules/appointments/appointment-authorization.js';
import { PostgresAppointmentAuthorizationRepository } from './modules/appointments/postgres-appointment-authorization-repository.js';
import { CancellationService } from './modules/appointments/cancellation-refunds.js';
import { PostgresCancellationRefundRepository } from './modules/appointments/postgres-cancellation-refund-repository.js';
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
  void app.register(async (instance) => registerServiceExposureRoutes(instance, { exposures: new ServiceExposureService(new PostgresServiceExposureRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  const paymentProvider = new RazorpayPaymentProvider(environment.RAZORPAY_KEY_ID, environment.RAZORPAY_KEY_SECRET, environment.RAZORPAY_WEBHOOK_SECRET);
  void app.register(async (instance) => registerAppointmentIntentRoutes(instance, {
    appointments: new AppointmentService(new PostgresAppointmentRepository(services.database), audit),
    handoffs: new PaymentHandoffService(new PostgresPaymentHandoffRepository(services.database), resolvePaymentProviderKey(environment.PAYMENT_PROVIDER_KEY)),
    provisioning: new PaymentOrderProvisioningService(new PostgresPaymentOrderProvisioningRepository(services.database), paymentProvider, environment.PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerRazorpayWebhookRoutes(instance, { confirmation: new PaymentConfirmationService(paymentProvider, new PostgresPaymentConfirmationRepository(services.database)) }));
  void app.register(async (instance) => registerAppointmentCancellationRoutes(instance, {
    cancellations: new CancellationService(new PostgresCancellationRefundRepository(services.database), new AppointmentAuthorizationService(new PostgresAppointmentAuthorizationRepository(services.database), context, audit)),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));

  return { app, services };
}

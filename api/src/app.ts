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
import { FirebaseSessionBridge } from './modules/sessions/firebase-session-bridge.js';
import { AdminFirebaseSessionBridge } from './modules/sessions/admin-firebase-session-bridge.js';
import { AccountIdentityService, adminFirebaseIdentityProviders, FirebaseAdminIdentityVerifier, FirebaseProviderPolicyVerifier, ownerFirebaseIdentityProviders, sharedFirebaseIdentityProviders } from './modules/identity/identity.js';
import { PostgresAccountIdentityRepository } from './modules/identity/postgres-account-identity-repository.js';
import { registerAuthSessionRoutes } from './routes/auth-sessions.js';
import { registerAdminAuthSessionRoutes } from './routes/admin-auth-sessions.js';
import { registerTenantOwnerOnboardingRoutes } from './routes/tenant-owner-onboarding.js';
import { TenantFirebaseSessionBridge } from './modules/sessions/tenant-firebase-session-bridge.js';
import { PostgresTenantOwnerOnboardingRepository } from './modules/tenant-onboarding/postgres-tenant-owner-onboarding-repository.js';
import { TenantOwnerOnboardingService } from './modules/tenant-onboarding/tenant-owner-onboarding.js';
import { registerAdminReadRoutes } from './routes/admin-read.js';
import { AdminReadService } from './modules/admin-read/admin-read.js';
import { PostgresAdminReadRepository } from './modules/admin-read/postgres-admin-read-repository.js';
import { registerPlatformAdminRoutes } from './routes/platform-admin.js';
import { PlatformAdminService } from './modules/platform-admin/platform-admin.js';
import { PostgresPlatformAdminRepository } from './modules/platform-admin/postgres-platform-admin-repository.js';
import { PublicDiscoveryControlService } from './modules/platform-admin/public-discovery-control.js';
import { PostgresPublicDiscoveryControlRepository } from './modules/platform-admin/postgres-public-discovery-control-repository.js';
import { PlatformAdminEntitlementService, PostgresPlatformAdminEntitlementRepository } from './modules/admin-access/admin-entitlements.js';
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
import { registerDelegatedBookingRoutes } from './routes/delegated-bookings.js';
import { DelegatedBookingService } from './modules/appointments/delegated-bookings.js';
import { PostgresDelegatedBookingRepository } from './modules/appointments/postgres-delegated-booking-repository.js';
import { registerServiceExposureRoutes } from './routes/service-exposures.js';
import { PostgresServiceExposureRepository } from './modules/service-exposures/postgres-service-exposure-repository.js';
import { ServiceExposureService } from './modules/service-exposures/service-exposures.js';
import { registerClinicServiceDoctorAssignmentRoutes } from './routes/clinic-service-doctors.js';
import { PostgresClinicServiceDoctorAssignmentRepository } from './modules/clinic-service-doctors/postgres-clinic-service-doctors-repository.js';
import { ClinicServiceDoctorAssignmentService } from './modules/clinic-service-doctors/clinic-service-doctors.js';
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
import { CancellationService, RefundExecutionService } from './modules/appointments/cancellation-refunds.js';
import { PostgresCancellationRefundRepository } from './modules/appointments/postgres-cancellation-refund-repository.js';
import { RescheduleService } from './modules/appointments/rescheduling.js';
import { PostgresRescheduleRepository } from './modules/appointments/postgres-rescheduling-repository.js';
import { registerAppointmentRescheduleRoutes } from './routes/appointment-reschedules.js';
import { registerAppointmentOperationRoutes } from './routes/appointment-operations.js';
import { AppointmentLifecycleService } from './modules/appointments/appointment-lifecycle.js';
import { PostgresAppointmentLifecycleRepository } from './modules/appointments/postgres-appointment-lifecycle-repository.js';
import { AppointmentChatService } from './modules/chat/appointment-chat.js';
import { PostgresAppointmentChatRepository } from './modules/chat/postgres-appointment-chat-repository.js';
import { registerAppointmentChatRoutes } from './routes/appointment-chat.js';
import { AppointmentPrescriptionService } from './modules/prescriptions/appointment-prescriptions.js';
import { PostgresAppointmentPrescriptionRepository } from './modules/prescriptions/postgres-appointment-prescription-repository.js';
import { registerAppointmentPrescriptionRoutes } from './routes/appointment-prescriptions.js';
import { registerPublicDiscoveryRoutes } from './routes/public-discovery.js';
import { PublicDiscoveryService } from './modules/discovery/public-discovery.js';
import { PostgresPublicDiscoveryRepository } from './modules/discovery/postgres-public-discovery-repository.js';
import { registerProviderPortalRoutes } from './routes/provider-portal.js';
import { ProviderPortalService } from './modules/provider-portal/provider-portal.js';
import { PostgresProviderPortalRepository } from './modules/provider-portal/postgres-provider-portal-repository.js';
import { ProviderFirebaseSessionBridge } from './modules/sessions/provider-firebase-session-bridge.js';
import { ProviderPasswordIdentityLinkService } from './modules/sessions/provider-password-identity-link.js';
import { registerProviderAuthSessionRoutes } from './routes/provider-auth-sessions.js';
import { registerDoctorInvitationAcceptanceRoutes } from './routes/doctor-invitation-acceptance.js';
import { registerInvitationPreviewRoutes } from './routes/invitation-preview.js';
import { DoctorInvitationAcceptanceService } from './modules/platform-admin/doctor-invitation-acceptance.js';
import { PostgresDoctorInvitationAcceptanceRepository } from './modules/platform-admin/postgres-doctor-invitation-acceptance-repository.js';
import { DoctorVerificationService } from './modules/doctor-verification/doctor-verification.js';
import { PostgresDoctorVerificationRepository } from './modules/doctor-verification/postgres-doctor-verification-repository.js';
import { registerDoctorVerificationRoutes } from './routes/doctor-verification.js';
import { VerificationEvidenceService } from './modules/doctor-verification/verification-evidence.js';
import { PostgresVerificationEvidenceRepository } from './modules/doctor-verification/postgres-verification-evidence-repository.js';
import { registerDoctorVerificationEvidenceRoutes } from './routes/doctor-verification-evidence.js';
import { DoctorApplicationService } from './modules/doctor-applications/doctor-applications.js';
import { PostgresDoctorApplicationRepository } from './modules/doctor-applications/postgres-doctor-application-repository.js';
import { registerDoctorApplicationRoutes } from './routes/doctor-applications.js';
import { ClinicApplicationService } from './modules/clinic-applications/clinic-applications.js';
import { PostgresClinicApplicationRepository } from './modules/clinic-applications/postgres-clinic-application-repository.js';
import { registerClinicApplicationRoutes } from './routes/clinic-applications.js';
import { AicS3StorageProvider } from './modules/files/aic-s3-storage-provider.js';
import { browserOrigins } from './config/browser-origins.js';
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
  void app.register(cors, { origin: browserOrigins(environment.WEB_URL), credentials: true });
  registerErrorHandler(app);
  void app.register(async (instance) => registerStatusRoutes(instance, services));
  void app.register(async (instance) => registerPublicDiscoveryRoutes(instance, { discovery: new PublicDiscoveryService(new PostgresPublicDiscoveryRepository(services.database)) }));
  void app.register(async (instance) => registerAuthSessionRoutes(instance, {
    sessions: new FirebaseSessionBridge(
      new AccountIdentityService(new PostgresAccountIdentityRepository(services.database)),
      new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(environment.FIREBASE_PROJECT_ID), sharedFirebaseIdentityProviders),
      new PostgresSessionRepository(services.database),
      { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
    ),
  }));
  void app.register(async (instance) => registerAdminAuthSessionRoutes(instance, {
    sessions: new AdminFirebaseSessionBridge(
      new PostgresAccountIdentityRepository(services.database),
      new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(environment.FIREBASE_PROJECT_ID), adminFirebaseIdentityProviders),
      new PlatformAdminEntitlementService(new PostgresPlatformAdminEntitlementRepository(services.database)),
      new PostgresSessionRepository(services.database),
      { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
    ),
  }));
  void app.register(async (instance) => registerProfileRoutes(instance, {
    profiles: new ProfileService(new PostgresProfileRepository(services.database), new PostgresAuditRepository(services.database)),
    sessions: new PostgresSessionRepository(services.database),
    sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  const audit = new PostgresAuditRepository(services.database);
  const memberships = new PostgresMembershipRepository(services.database);
  const platformAdmins = new PlatformAdminEntitlementService(new PostgresPlatformAdminEntitlementRepository(services.database));
  const context = new TenantContextService(memberships, audit, platformAdmins);
  const doctorVerification = new DoctorVerificationService(new PostgresDoctorVerificationRepository(services.database), platformAdmins, audit);
  const doctorApplications = new DoctorApplicationService(new PostgresDoctorApplicationRepository(services.database), platformAdmins, audit);
  const verificationEvidence = new VerificationEvidenceService(new PostgresVerificationEvidenceRepository(services.database), AicS3StorageProvider.fromEnvironment(environment), environment.AIC_S3_BUCKET, platformAdmins, audit);
  const ownerOnboarding = new PostgresTenantOwnerOnboardingRepository(services.database);
  const tenantOwnerOnboarding = new TenantOwnerOnboardingService(ownerOnboarding, platformAdmins);
  const clinicApplications = new ClinicApplicationService(new PostgresClinicApplicationRepository(services.database), platformAdmins, tenantOwnerOnboarding, audit);
  const sessionPolicy = { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS };
  const sessionRepository = new PostgresSessionRepository(services.database);
  const providerPortal = new PostgresProviderPortalRepository(services.database);
  void app.register(async (instance) => registerDoctorInvitationAcceptanceRoutes(instance, { acceptance: new DoctorInvitationAcceptanceService(new PostgresDoctorInvitationAcceptanceRepository(services.database)), firebaseProjectId: environment.FIREBASE_PROJECT_ID }));
  void app.register(async (instance) => registerInvitationPreviewRoutes(instance, { database: services.database }));
  void app.register(async (instance) => registerProviderAuthSessionRoutes(instance, {
    sessions: new ProviderFirebaseSessionBridge(new PostgresAccountIdentityRepository(services.database), new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(environment.FIREBASE_PROJECT_ID), ownerFirebaseIdentityProviders), { create: sessionRepository.create.bind(sessionRepository), hasActiveProviderAccess: providerPortal.hasActiveProviderAccess.bind(providerPortal) }, sessionPolicy),
    passwordIdentityLinks: new ProviderPasswordIdentityLinkService(new PostgresAccountIdentityRepository(services.database), new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(environment.FIREBASE_PROJECT_ID), ['firebase_password']), audit),
    sessionRepository,
    sessionPolicy,
  }));
  void app.register(async (instance) => registerTenantOwnerOnboardingRoutes(instance, {
    onboarding: tenantOwnerOnboarding,
    tenantSessions: new TenantFirebaseSessionBridge(new PostgresAccountIdentityRepository(services.database), new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(environment.FIREBASE_PROJECT_ID), ownerFirebaseIdentityProviders), { create: sessionRepository.create.bind(sessionRepository), hasActiveOwnerMembership: ownerOnboarding.hasActiveOwnerMembership.bind(ownerOnboarding) }, sessionPolicy),
    sessions: sessionRepository,
    sessionPolicy,
    environment,
  }));
  void app.register(async (instance) => registerPlatformAdminRoutes(instance, {
    platform: new PlatformAdminService(new PostgresPlatformAdminRepository(services.database), platformAdmins, audit),
    discovery: new PublicDiscoveryControlService(new PostgresPublicDiscoveryControlRepository(services.database), platformAdmins),
    sessions: sessionRepository,
    sessionPolicy,
  }));
  void app.register(async (instance) => registerDoctorVerificationRoutes(instance, { verification: doctorVerification, sessions: sessionRepository, sessionPolicy }));
  void app.register(async (instance) => registerDoctorApplicationRoutes(instance, { applications: doctorApplications, sessions: sessionRepository, sessionPolicy }));
  void app.register(async (instance) => registerClinicApplicationRoutes(instance, { applications: clinicApplications, sessions: sessionRepository, sessionPolicy }));
  void app.register(async (instance) => registerDoctorVerificationEvidenceRoutes(instance, { evidence: verificationEvidence, sessions: sessionRepository, sessionPolicy }));
  const elevatedAppointmentAuthorization = { authorize: async (accountId: string) => platformAdmins.hasActiveEntitlement(accountId) };
  void app.register(async (instance) => registerAdminReadRoutes(instance, { reads: new AdminReadService(new PostgresAdminReadRepository(services.database), context, platformAdmins), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  const appointmentAuthorization = new AppointmentAuthorizationService(new PostgresAppointmentAuthorizationRepository(services.database), context, audit, elevatedAppointmentAuthorization);
  void app.register(async (instance) => registerProviderPortalRoutes(instance, { portal: new ProviderPortalService(providerPortal, context), sessions: sessionRepository, sessionPolicy }));
  void app.register(async (instance) => registerClinicRoutes(instance, { clinics: new TenantClinicService(new PostgresTenantRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerMembershipRoutes(instance, { memberships: new MembershipService(memberships, context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerNetworkRoutes(instance, { network: new NetworkService(new PostgresNetworkRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerServiceOfferingRoutes(instance, { offerings: new ServiceOfferingService(new PostgresServiceOfferingRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerAvailabilityRoutes(instance, { availability: new AvailabilityService(new PostgresAvailabilityRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerServiceExposureRoutes(instance, { exposures: new ServiceExposureService(new PostgresServiceExposureRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  void app.register(async (instance) => registerClinicServiceDoctorAssignmentRoutes(instance, { assignments: new ClinicServiceDoctorAssignmentService(new PostgresClinicServiceDoctorAssignmentRepository(services.database), context, audit), sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS } }));
  const paymentProvider = environment.RAZORPAY_KEY_ID && environment.RAZORPAY_KEY_SECRET && environment.RAZORPAY_WEBHOOK_SECRET
    ? new RazorpayPaymentProvider(environment.RAZORPAY_KEY_ID, environment.RAZORPAY_KEY_SECRET, environment.RAZORPAY_WEBHOOK_SECRET)
    : undefined;
  const cancellationRefunds = new PostgresCancellationRefundRepository(services.database);
  const refundExecution = paymentProvider ? new RefundExecutionService(cancellationRefunds, paymentProvider) : undefined;
  const confirmation = paymentProvider ? new PaymentConfirmationService(paymentProvider, new PostgresPaymentConfirmationRepository(services.database)) : undefined;
  void app.register(async (instance) => registerAppointmentIntentRoutes(instance, {
    appointments: new AppointmentService(new PostgresAppointmentRepository(services.database), audit),
    handoffs: new PaymentHandoffService(new PostgresPaymentHandoffRepository(services.database), resolvePaymentProviderKey(environment.PAYMENT_PROVIDER_KEY)),
    provisioning: new PaymentOrderProvisioningService(new PostgresPaymentOrderProvisioningRepository(services.database), paymentProvider, environment.PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS),
    confirmation,
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerDelegatedBookingRoutes(instance, {
    bookings: new DelegatedBookingService(new PostgresDelegatedBookingRepository(services.database), audit),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerRazorpayWebhookRoutes(instance, { confirmation }));
  void app.register(async (instance) => registerAppointmentCancellationRoutes(instance, {
    cancellations: new CancellationService(cancellationRefunds, new AppointmentAuthorizationService(new PostgresAppointmentAuthorizationRepository(services.database), context, audit, elevatedAppointmentAuthorization)), refunds: refundExecution,
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerAppointmentRescheduleRoutes(instance, {
    reschedules: new RescheduleService(new PostgresAppointmentRepository(services.database), new PostgresRescheduleRepository(services.database), new AppointmentAuthorizationService(new PostgresAppointmentAuthorizationRepository(services.database), context, audit, elevatedAppointmentAuthorization)),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerAppointmentOperationRoutes(instance, {
    lifecycle: new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(services.database)),
    authorization: appointmentAuthorization,
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerAppointmentChatRoutes(instance, {
    chat: new AppointmentChatService(new PostgresAppointmentChatRepository(services.database)),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));
  void app.register(async (instance) => registerAppointmentPrescriptionRoutes(instance, {
    prescriptions: new AppointmentPrescriptionService(new PostgresAppointmentPrescriptionRepository(services.database)),
    sessions: new PostgresSessionRepository(services.database), sessionPolicy: { idleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS, absoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS },
  }));

  return { app, services };
}

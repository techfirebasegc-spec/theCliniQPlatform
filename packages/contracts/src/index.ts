export type ServiceStatus = 'ok' | 'unavailable';

export const accountStatuses = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED_REQUESTED', 'DELETED'] as const;
export type AccountStatus = (typeof accountStatuses)[number];

export const authenticationIdentityProviders = ['firebase_google', 'firebase_phone'] as const;
export type AuthenticationIdentityProvider = (typeof authenticationIdentityProviders)[number];

export const authenticationIdentityStatuses = ['LINKED', 'UNLINKED', 'COMPROMISED', 'DISABLED'] as const;
export type AuthenticationIdentityStatus = (typeof authenticationIdentityStatuses)[number];

export const sessionStatuses = ['ACTIVE', 'EXPIRED', 'REVOKED', 'REPLACED', 'SUSPICIOUS'] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const patientProfileStatuses = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type PatientProfileStatus = (typeof patientProfileStatuses)[number];

export const doctorProfileStatuses = ['DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type DoctorProfileStatus = (typeof doctorProfileStatuses)[number];

export const professionalVerificationStatuses = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export type ProfessionalVerificationStatus = (typeof professionalVerificationStatuses)[number];

export const tenantStatuses = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ARCHIVED'] as const;
export type TenantStatus = (typeof tenantStatuses)[number];

export const clinicStatuses = ['DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type ClinicStatus = (typeof clinicStatuses)[number];

export const tenantMembershipRoles = ['CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF'] as const;
export type TenantMembershipRole = (typeof tenantMembershipRoles)[number];

export const tenantMembershipStatuses = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED', 'EXPIRED'] as const;
export type TenantMembershipStatus = (typeof tenantMembershipStatuses)[number];

export const networkConnectionKinds = ['CLINIC_CLINIC', 'CLINIC_DOCTOR'] as const;
export type NetworkConnectionKind = (typeof networkConnectionKinds)[number];

export const networkConnectionStatuses = ['PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'BLOCKED'] as const;
export type NetworkConnectionStatus = (typeof networkConnectionStatuses)[number];

export const networkConnectionCapabilities = ['DISCOVER', 'CONTACT'] as const;
export type NetworkConnectionCapability = (typeof networkConnectionCapabilities)[number];

export const networkConnectionCapabilityStatuses = ['ACTIVE', 'REVOKED'] as const;
export type NetworkConnectionCapabilityStatus = (typeof networkConnectionCapabilityStatuses)[number];

export const auditCategories = ['SECURITY', 'AUTHORIZATION', 'BUSINESS'] as const;
export type AuditCategory = (typeof auditCategories)[number];

export const auditOutcomes = ['SUCCESS', 'DENIED', 'FAILURE'] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

export const phase2IdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function isPhase2Identifier(value: string): boolean {
  return phase2IdentifierPattern.test(value);
}

export function isIsoTimestamp(value: string): boolean {
  return isoTimestampPattern.test(value) && !Number.isNaN(Date.parse(value));
}

export function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
}

export type ApiErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'VALIDATION_ERROR';

export interface HealthResponse {
  status: 'ok';
  service: 'cliniq-core-api';
}

export interface ReadinessResponse {
  status: ServiceStatus;
  dependencies: {
    database: ServiceStatus;
    redis: ServiceStatus;
  };
}

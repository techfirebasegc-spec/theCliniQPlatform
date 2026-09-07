export interface AuditEventInput {
  category: 'SECURITY' | 'AUTHORIZATION' | 'BUSINESS';
  eventType: string;
  actorAccountId?: string;
  tenantId?: string;
  targetType: string;
  targetId?: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditRepository {
  append(event: AuditEventInput): Promise<void>;
}

export async function recordAuthorizationDenial(repository: AuditRepository, actorAccountId: string, tenantId: string): Promise<void> {
  await repository.append({ category: 'AUTHORIZATION', eventType: 'TENANT_ACCESS_DENIED', actorAccountId, tenantId, targetType: 'TENANT', targetId: tenantId, outcome: 'DENIED' });
}

export function createAuthorizationAudit(repository: AuditRepository) {
  return { recordDenial: (accountId: string, tenantId: string) => recordAuthorizationDenial(repository, accountId, tenantId) };
}

import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { AdminAppointment, AdminMembership, AdminReadRepository, AdminServiceOffering, AdminTenantContext, AppointmentListFilter, Page } from './admin-read.js';

export class PostgresAdminReadRepository implements AdminReadRepository {
  public constructor(private readonly database: DatabaseHealth) {}

  public async listContexts(accountId: string): Promise<AdminTenantContext[]> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT membership.id AS membership_id, membership.tenant_id, membership.role_key,
        clinic.id AS clinic_id, clinic.display_name AS clinic_display_name, clinic.status AS clinic_status
      FROM tenant_memberships membership
      JOIN tenants tenant ON tenant.id=membership.tenant_id AND tenant.status='ACTIVE'
      LEFT JOIN clinics clinic ON clinic.tenant_id=tenant.id
      WHERE membership.account_id=$1 AND membership.status='ACTIVE'
      ORDER BY clinic.display_name NULLS LAST, membership.id
    `, [accountId]);
    return result.rows.map((row) => ({ membershipId: String(row.membership_id), tenantId: String(row.tenant_id), role: row.role_key as Exclude<AdminTenantContext['role'], 'PLATFORM_ADMIN'>, access: 'TENANT_MEMBERSHIP' as const, clinic: row.clinic_id ? { id: String(row.clinic_id), displayName: String(row.clinic_display_name), status: String(row.clinic_status) } : null }));
  }

  public async listAllActiveContexts(): Promise<AdminTenantContext[]> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT tenant.id AS tenant_id, clinic.id AS clinic_id, clinic.display_name AS clinic_display_name, clinic.status AS clinic_status
      FROM tenants tenant
      LEFT JOIN clinics clinic ON clinic.tenant_id=tenant.id
      WHERE tenant.status='ACTIVE'
      ORDER BY clinic.display_name NULLS LAST, tenant.id
    `, []);
    return result.rows.map((row) => ({ membershipId: null, tenantId: String(row.tenant_id), role: 'PLATFORM_ADMIN', access: 'PLATFORM_ADMIN', clinic: row.clinic_id ? { id: String(row.clinic_id), displayName: String(row.clinic_display_name), status: String(row.clinic_status) } : null }));
  }

  public async listMemberships(tenantId: string, page: Page): Promise<AdminMembership[]> {
    const result = await this.database.query<Record<string, unknown>>('SELECT id,account_id,role_key,status FROM tenant_memberships WHERE tenant_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3', [tenantId, page.limit, page.offset]);
    return result.rows.map((row) => ({ id: String(row.id), accountId: String(row.account_id), role: row.role_key as AdminMembership['role'], status: String(row.status) }));
  }
  public async countMemberships(tenantId: string): Promise<number> { return count(await this.database.query('SELECT count(*)::text AS count FROM tenant_memberships WHERE tenant_id=$1', [tenantId])); }

  public async listAppointments(tenantId: string, filter: AppointmentListFilter): Promise<AdminAppointment[]> {
    const { where, values } = appointmentWhere(tenantId, filter);
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT appointment.id, patient.id AS patient_profile_id, patient.display_name AS patient_display_name,
        offering.id AS service_offering_id, offering.name AS service_name, appointment.status, appointment.starts_at, appointment.ends_at
      FROM appointments appointment
      JOIN clinics clinic ON clinic.id=appointment.provider_clinic_id
      JOIN service_offerings offering ON offering.id=appointment.service_offering_id
      LEFT JOIN patient_profiles patient ON patient.account_id=appointment.patient_account_id
      WHERE ${where}
      ORDER BY appointment.starts_at DESC, appointment.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `, [...values, filter.limit, filter.offset]);
    return result.rows.map((row) => ({ id: String(row.id), patientProfileId: row.patient_profile_id ? String(row.patient_profile_id) : null, patientDisplayName: row.patient_display_name ? String(row.patient_display_name) : null, serviceOfferingId: String(row.service_offering_id), serviceName: String(row.service_name), status: String(row.status), startsAt: new Date(String(row.starts_at)), endsAt: new Date(String(row.ends_at)) }));
  }

  public async countAppointments(tenantId: string, filter: Omit<AppointmentListFilter, 'limit' | 'offset'>): Promise<number> {
    const { where, values } = appointmentWhere(tenantId, filter);
    return count(await this.database.query(`SELECT count(*)::text AS count FROM appointments appointment JOIN clinics clinic ON clinic.id=appointment.provider_clinic_id WHERE ${where}`, values));
  }

  public async listServices(tenantId: string, page: Page): Promise<AdminServiceOffering[]> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT offering.id,offering.name,offering.description,offering.status
      FROM service_offerings offering JOIN clinics clinic ON clinic.id=offering.owner_clinic_id
      WHERE clinic.tenant_id=$1 ORDER BY offering.created_at,offering.id LIMIT $2 OFFSET $3
    `, [tenantId, page.limit, page.offset]);
    return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), description: row.description === null ? null : String(row.description), status: String(row.status) }));
  }
  public async countServices(tenantId: string): Promise<number> { return count(await this.database.query('SELECT count(*)::text AS count FROM service_offerings offering JOIN clinics clinic ON clinic.id=offering.owner_clinic_id WHERE clinic.tenant_id=$1', [tenantId])); }
}

function appointmentWhere(tenantId: string, filter: Omit<AppointmentListFilter, 'limit' | 'offset'>) {
  const clauses = ['clinic.tenant_id=$1']; const values: unknown[] = [tenantId];
  if (filter.from) { values.push(filter.from); clauses.push(`appointment.starts_at >= $${values.length}`); }
  if (filter.to) { values.push(filter.to); clauses.push(`appointment.starts_at < $${values.length}`); }
  if (filter.status) { values.push(filter.status); clauses.push(`appointment.status = $${values.length}`); }
  return { where: clauses.join(' AND '), values };
}

function count(result: { rows: Record<string, unknown>[] }): number { return Number(result.rows[0]?.count ?? 0); }

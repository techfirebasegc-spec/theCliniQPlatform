import { createHash, randomBytes } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type PlatformClinic = { id: string; tenantId: string; displayName: string; legalName: string; clinicStatus: string; tenantStatus: string; ownerEmail: string | null; ownerMembershipStatus: string | null; invitationStatus: string | null };
export type PlatformDoctor = { id: string; accountId: string; displayName: string | null; status: string; professionalVerificationStatus: string; clinicNames: string[] };
export type DoctorInvitation = { id: string; targetAccountId: string; email: string; displayName: string | null; status: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; acceptedAt: Date | null };
export type PlatformMetrics = { clinics: number; doctors: number; patients: number; activeInvitations: number; upcomingAppointments: number };
export class PlatformAdminError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Platform administration is not permitted.' : code === 'NOT_FOUND' ? 'The requested platform record was not found.' : 'The platform operation cannot be completed.'); } }

export interface PlatformAdminRepository {
  listClinics(): Promise<PlatformClinic[]>;
  findClinic(id: string): Promise<PlatformClinic | null>;
  listDoctors(): Promise<PlatformDoctor[]>;
  findDoctor(id: string): Promise<PlatformDoctor | null>;
  listDoctorInvitations(): Promise<DoctorInvitation[]>;
  metrics(): Promise<PlatformMetrics>;
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  createDoctorInvitation(database: PostgresExecutor, actorId: string, invitation: DoctorInvitation & { secretHash: string }): Promise<void>;
  lockDoctorInvitation(database: PostgresExecutor, id: string): Promise<(DoctorInvitation & { secretHash: string }) | null>;
  revokeDoctorInvitation(database: PostgresExecutor, id: string, actorId: string): Promise<void>;
  replaceDoctorInvitation(database: PostgresExecutor, actorId: string, previous: DoctorInvitation, secretHash: string): Promise<DoctorInvitation>;
  lockClinicForActivation(database: PostgresExecutor, id: string): Promise<{ id: string; tenantId: string; clinicStatus: string; tenantStatus: string } | null>;
  hasActiveClinicOwner(database: PostgresExecutor, tenantId: string): Promise<boolean>;
  activateClinic(database: PostgresExecutor, id: string, actorId: string): Promise<PlatformClinic | null>;
}
export interface PlatformAdminEntitlements { hasActiveEntitlement(accountId: string): Promise<boolean>; }

export class PlatformAdminService {
  public constructor(private readonly repository: PlatformAdminRepository, private readonly entitlements: PlatformAdminEntitlements, private readonly audit: AuditRepository, private readonly now: () => Date = () => new Date()) {}
  public async clinics(actor: string | undefined) { await this.require(actor); return this.repository.listClinics(); }
  public async clinic(actor: string | undefined, id: string) { await this.require(actor); const clinic = await this.repository.findClinic(id); if (!clinic) throw new PlatformAdminError('NOT_FOUND'); return clinic; }
  public async doctors(actor: string | undefined) { await this.require(actor); return this.repository.listDoctors(); }
  public async doctor(actor: string | undefined, id: string) { await this.require(actor); const doctor = await this.repository.findDoctor(id); if (!doctor) throw new PlatformAdminError('NOT_FOUND'); return doctor; }
  public async invitations(actor: string | undefined) { await this.require(actor); return this.repository.listDoctorInvitations(); }
  public async dashboard(actor: string | undefined) { await this.require(actor); return this.repository.metrics(); }
  public async inviteDoctor(actor: string | undefined, input: { email: string; displayName?: string }) {
    const accountId = await this.require(actor); const email = normalizeEmail(input.email); if (!validEmail(email) || (input.displayName !== undefined && !input.displayName.trim())) throw new PlatformAdminError('CONFLICT');
    const secret = randomBytes(32).toString('base64url'); const invitation: DoctorInvitation & { secretHash: string } = { id: createIdentifier(), targetAccountId: createIdentifier(), email, displayName: input.displayName?.trim() || null, status: 'INVITED', createdAt: this.now(), expiresAt: expiry(this.now()), revokedAt: null, acceptedAt: null, secretHash: hashSecret(secret) };
    await this.repository.transaction((database) => this.repository.createDoctorInvitation(database, accountId, invitation));
    return { invitation, secret };
  }
  public async resendDoctorInvitation(actor: string | undefined, id: string) {
    const accountId = await this.require(actor); const secret = randomBytes(32).toString('base64url');
    const invitation = await this.repository.transaction(async (database) => { const previous = await this.repository.lockDoctorInvitation(database, id); if (!previous || previous.status !== 'INVITED' || previous.expiresAt <= this.now()) throw new PlatformAdminError('CONFLICT'); await this.repository.revokeDoctorInvitation(database, id, accountId); return this.repository.replaceDoctorInvitation(database, accountId, previous, hashSecret(secret)); });
    return { invitation, secret };
  }
  public async revokeDoctorInvitation(actor: string | undefined, id: string) { const accountId = await this.require(actor); await this.repository.transaction(async (database) => { const invitation = await this.repository.lockDoctorInvitation(database, id); if (!invitation || invitation.status !== 'INVITED') throw new PlatformAdminError('CONFLICT'); await this.repository.revokeDoctorInvitation(database, id, accountId); }); }
  public async activateClinic(actor: string | undefined, id: string) {
    const accountId = await this.require(actor);
    const clinic = await this.repository.transaction(async (database) => {
      const current = await this.repository.lockClinicForActivation(database, id);
      if (!current) throw new PlatformAdminError('NOT_FOUND');
      if (current.clinicStatus !== 'DRAFT' || current.tenantStatus !== 'ACTIVE' || !await this.repository.hasActiveClinicOwner(database, current.tenantId)) throw new PlatformAdminError('CONFLICT');
      const activated = await this.repository.activateClinic(database, id, accountId);
      if (!activated) throw new PlatformAdminError('CONFLICT');
      return activated;
    });
    await this.audit.append({ category: 'BUSINESS', eventType: 'CLINIC_ACTIVATED', actorAccountId: accountId, tenantId: clinic.tenantId, targetType: 'CLINIC', targetId: clinic.id, outcome: 'SUCCESS' });
    return clinic;
  }
  private async require(actor: string | undefined) { if (!actor) throw new PlatformAdminError('UNAUTHORIZED'); if (!await this.entitlements.hasActiveEntitlement(actor)) throw new PlatformAdminError('FORBIDDEN'); return actor; }
}
export function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
export function hashSecret(value: string) { return createHash('sha256').update(value).digest('base64url'); }
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function expiry(now: Date) { return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); }

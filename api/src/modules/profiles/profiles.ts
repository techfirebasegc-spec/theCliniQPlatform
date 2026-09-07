import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';

export type PatientProfile = { id: string; accountId: string; status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'; displayName: string | null };
export type DoctorProfile = { id: string; accountId: string; status: 'DRAFT' | 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'; displayName: string | null; professionalVerificationStatus: 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' };
export type ProfileMutation = { displayName?: string | null };

export interface ProfileRepository {
  createPatient(profile: PatientProfile): Promise<PatientProfile>;
  createDoctor(profile: DoctorProfile): Promise<DoctorProfile>;
  findPatientForAccount(profileId: string, accountId: string): Promise<PatientProfile | null>;
  findDoctorForAccount(profileId: string, accountId: string): Promise<DoctorProfile | null>;
  updatePatientForAccount(profileId: string, accountId: string, mutation: ProfileMutation): Promise<PatientProfile | null>;
  updateDoctorForAccount(profileId: string, accountId: string, mutation: ProfileMutation): Promise<DoctorProfile | null>;
}

export class ProfileAccessError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'CONFLICT' | 'FORBIDDEN') {
    super(code === 'CONFLICT' ? 'Profile already exists.' : code === 'UNAUTHORIZED' ? 'Authentication is required.' : 'Profile access is not permitted.');
  }
}

export class ProfileService {
  public constructor(private readonly repository: ProfileRepository, private readonly audit: AuditRepository) {}

  public createPatient(accountId: string | undefined, mutation: ProfileMutation): Promise<PatientProfile> {
    return this.create(accountId, () => this.repository.createPatient({ id: createIdentifier(), accountId: this.requireAccount(accountId), status: 'ACTIVE', displayName: mutation.displayName ?? null }));
  }

  public createDoctor(accountId: string | undefined, mutation: ProfileMutation): Promise<DoctorProfile> {
    return this.create(accountId, () => this.repository.createDoctor({ id: createIdentifier(), accountId: this.requireAccount(accountId), status: 'DRAFT', displayName: mutation.displayName ?? null, professionalVerificationStatus: 'NOT_SUBMITTED' }));
  }

  public async readPatient(accountId: string | undefined, profileId: string): Promise<PatientProfile> {
    return this.requireOwned('PATIENT_PROFILE', accountId, profileId, this.repository.findPatientForAccount(profileId, this.requireAccount(accountId)));
  }

  public async readDoctor(accountId: string | undefined, profileId: string): Promise<DoctorProfile> {
    return this.requireOwned('DOCTOR_PROFILE', accountId, profileId, this.repository.findDoctorForAccount(profileId, this.requireAccount(accountId)));
  }

  public async updatePatient(accountId: string | undefined, profileId: string, mutation: ProfileMutation): Promise<PatientProfile> {
    return this.requireOwned('PATIENT_PROFILE', accountId, profileId, this.repository.updatePatientForAccount(profileId, this.requireAccount(accountId), mutation));
  }

  public async updateDoctor(accountId: string | undefined, profileId: string, mutation: ProfileMutation): Promise<DoctorProfile> {
    return this.requireOwned('DOCTOR_PROFILE', accountId, profileId, this.repository.updateDoctorForAccount(profileId, this.requireAccount(accountId), mutation));
  }

  private requireAccount(accountId: string | undefined): string {
    if (!accountId) throw new ProfileAccessError('UNAUTHORIZED');
    return accountId;
  }

  private async create<T>(accountId: string | undefined, operation: () => Promise<T>): Promise<T> {
    this.requireAccount(accountId);
    try { return await operation(); } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ProfileAccessError('CONFLICT');
      throw error;
    }
  }

  private async requireOwned<T>(targetType: 'PATIENT_PROFILE' | 'DOCTOR_PROFILE', accountId: string | undefined, profileId: string, operation: Promise<T | null>): Promise<T> {
    const actorAccountId = this.requireAccount(accountId);
    const profile = await operation;
    if (profile) return profile;
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'PROFILE_ACCESS_DENIED', actorAccountId, targetType, targetId: profileId, outcome: 'DENIED' });
    throw new ProfileAccessError('FORBIDDEN');
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

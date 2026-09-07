import { PostgresProfileRepository } from '../src/modules/profiles/postgres-profile-repository.js';
import { ProfileAccessError, ProfileService, type DoctorProfile, type PatientProfile, type ProfileRepository } from '../src/modules/profiles/profiles.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerProfileRoutes } from '../src/routes/profiles.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

class Profiles implements ProfileRepository {
  public patients = new Map<string, PatientProfile>();
  public doctors = new Map<string, DoctorProfile>();
  public async createPatient(profile: PatientProfile) { if ([...this.patients.values()].some((item) => item.accountId === profile.accountId)) throw { code: '23505' }; this.patients.set(profile.id, profile); return profile; }
  public async createDoctor(profile: DoctorProfile) { if ([...this.doctors.values()].some((item) => item.accountId === profile.accountId)) throw { code: '23505' }; this.doctors.set(profile.id, profile); return profile; }
  public async findPatientForAccount(id: string, accountId: string) { const item = this.patients.get(id); return item?.accountId === accountId ? item : null; }
  public async findDoctorForAccount(id: string, accountId: string) { const item = this.doctors.get(id); return item?.accountId === accountId ? item : null; }
  public async updatePatientForAccount(id: string, accountId: string, mutation: { displayName?: string | null }) { const item = await this.findPatientForAccount(id, accountId); if (!item || item.status !== 'ACTIVE') return null; const updated = { ...item, displayName: mutation.displayName ?? null }; this.patients.set(id, updated); return updated; }
  public async updateDoctorForAccount(id: string, accountId: string, mutation: { displayName?: string | null }) { const item = await this.findDoctorForAccount(id, accountId); if (!item || !['DRAFT', 'PENDING_VERIFICATION', 'ACTIVE'].includes(item.status)) return null; const updated = { ...item, displayName: mutation.displayName ?? null }; this.doctors.set(id, updated); return updated; }
}

function setup() { const repository = new Profiles(); const audit = { events: [] as unknown[], append: async (event: unknown) => { audit.events.push(event); } }; return { repository, audit, service: new ProfileService(repository, audit) }; }

describe('Step 4 profile foundations', () => {
  it('creates, reads, and mutates a patient profile only for its Account', async () => {
    const { service } = setup(); const profile = await service.createPatient('patient-a', { displayName: 'Patient A' });
    await expect(service.readPatient('patient-a', profile.id)).resolves.toMatchObject({ accountId: 'patient-a', displayName: 'Patient A' });
    await expect(service.updatePatient('patient-a', profile.id, { displayName: 'Updated' })).resolves.toMatchObject({ displayName: 'Updated' });
  });
  it('creates, reads, and mutates a doctor profile only for its Account', async () => {
    const { service } = setup(); const profile = await service.createDoctor('doctor-a', { displayName: 'Doctor A' });
    expect(profile).toMatchObject({ accountId: 'doctor-a', status: 'DRAFT', professionalVerificationStatus: 'NOT_SUBMITTED' });
    await expect(service.readDoctor('doctor-a', profile.id)).resolves.toMatchObject({ accountId: 'doctor-a' });
    await expect(service.updateDoctor('doctor-a', profile.id, { displayName: 'Updated' })).resolves.toMatchObject({ displayName: 'Updated' });
  });
  it('denies another Account from reading or mutating profiles and audits the denial', async () => {
    const { service, audit } = setup(); const patient = await service.createPatient('owner', {}); const doctor = await service.createDoctor('owner', {});
    await expect(service.readPatient('other', patient.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.updatePatient('other', patient.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.readDoctor('other', doctor.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.updateDoctor('other', doctor.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(audit.events).toHaveLength(4);
  });
  it('does not accept an arbitrary account identifier or tenant context as ownership', async () => {
    const { service } = setup(); const patient = await service.createPatient('owner', {});
    await expect(service.readPatient('tenant-member', patient.id)).rejects.toBeInstanceOf(ProfileAccessError);
    await expect(service.readPatient(undefined, patient.id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('safely rejects duplicate patient and doctor profiles', async () => {
    const { service } = setup(); await service.createPatient('account', {}); await service.createDoctor('account', {});
    await expect(service.createPatient('account', {})).rejects.toMatchObject({ code: 'CONFLICT', message: 'Profile already exists.' });
    await expect(service.createDoctor('account', {})).rejects.toMatchObject({ code: 'CONFLICT', message: 'Profile already exists.' });
  });
  it('supports independent patient and doctor profiles without tenant, clinic, membership, or network inputs', async () => {
    const { service } = setup();
    await expect(service.createPatient('patient-without-tenant', {})).resolves.toMatchObject({ accountId: 'patient-without-tenant' });
    await expect(service.createDoctor('doctor-without-tenant', {})).resolves.toMatchObject({ accountId: 'doctor-without-tenant' });
  });
  it('rejects unauthenticated profile creation', async () => {
    const { service } = setup(); await expect(service.createPatient(undefined, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects an unauthenticated profile route before any profile access', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    await registerProfileRoutes(app, { profiles: service, sessions: { findBySecretHash: async () => null, touch: async () => ({ updated: true }) }, sessionPolicy: { idleTtlSeconds: 60, absoluteTtlSeconds: 120 } });
    const response = await app.inject({ method: 'POST', url: '/v1/me/patient-profile', payload: { displayName: 'Patient' } });
    expect(response.statusCode).toBe(401); expect(response.json().error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Authentication is required.' });
    await app.close();
  });
  it('does not let a session for another Account bypass profile ownership through a route identifier', async () => {
    const { service, audit } = setup(); const profile = await service.createPatient('owner', {}); const app = Fastify(); registerErrorHandler(app);
    await registerProfileRoutes(app, { profiles: service, sessions: { findBySecretHash: async () => ({ id: 'session', accountId: 'other', status: 'ACTIVE', idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) }), touch: async () => ({ updated: true }) }, sessionPolicy: { idleTtlSeconds: 60, absoluteTtlSeconds: 120 } });
    const response = await app.inject({ method: 'GET', url: `/v1/me/patient-profile/${profile.id}`, headers: { cookie: 'cliniq_session=session.secret' } });
    expect(response.statusCode).toBe(403); expect(audit.events).toHaveLength(1);
    await app.close();
  });
  it('derives creation ownership from the session and ignores immutable caller fields', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    await registerProfileRoutes(app, { profiles: service, sessions: { findBySecretHash: async () => ({ id: 'session', accountId: 'session-owner', status: 'ACTIVE', idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) }), touch: async () => ({ updated: true }) }, sessionPolicy: { idleTtlSeconds: 60, absoluteTtlSeconds: 120 } });
    const response = await app.inject({ method: 'POST', url: '/v1/me/doctor-profile', headers: { cookie: 'cliniq_session=session.secret' }, payload: { accountId: 'attacker', status: 'ACTIVE', professionalVerificationStatus: 'VERIFIED', displayName: 'Doctor' } });
    expect(response.statusCode).toBe(201); expect(response.json()).toMatchObject({ accountId: 'session-owner', status: 'DRAFT', professionalVerificationStatus: 'NOT_SUBMITTED', displayName: 'Doctor' });
    await app.close();
  });
  it('rejects revoked, replaced, and expired sessions through the profile route', async () => {
    for (const session of [
      { status: 'REVOKED' as const, idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) },
      { status: 'REPLACED' as const, idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) },
      { status: 'ACTIVE' as const, idleExpiresAt: new Date(Date.now() - 1), absoluteExpiresAt: new Date(Date.now() + 120_000) },
      { status: 'ACTIVE' as const, idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() - 1) },
    ]) {
      const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
      await registerProfileRoutes(app, { profiles: service, sessions: { findBySecretHash: async () => ({ id: 'session', accountId: 'account', ...session }), touch: async () => ({ updated: true }) }, sessionPolicy: { idleTtlSeconds: 60, absoluteTtlSeconds: 120 } });
      const response = await app.inject({ method: 'POST', url: '/v1/me/patient-profile', headers: { cookie: 'cliniq_session=session.secret' } });
      expect(response.statusCode).toBe(401); await app.close();
    }
  });
  it('cannot succeed when recording a profile-access denial fails', async () => {
    const repository = new Profiles(); const service = new ProfileService(repository, { append: async () => { throw new Error('AUDIT_FAILED'); } }); const profile = await new ProfileService(repository, { append: async () => {} }).createPatient('owner', {});
    await expect(service.readPatient('other', profile.id)).rejects.toThrow('AUDIT_FAILED');
  });
  it('binds all PostgreSQL reads and mutations to the authenticated Account and persists no credential fields', async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const repository = new PostgresProfileRepository({ query: async (text, values) => { calls.push({ text, values }); return { rows: [{ id: 'profile', account_id: 'account', status: 'ACTIVE', display_name: null, professional_verification_status: 'NOT_SUBMITTED' }] }; } });
    await repository.findPatientForAccount('profile', 'account'); await repository.findDoctorForAccount('profile', 'account'); await repository.updatePatientForAccount('profile', 'account', { displayName: 'Name' }); await repository.updateDoctorForAccount('profile', 'account', { displayName: 'Name' });
    expect(calls[0].text).toContain('id = $1 AND account_id = $2'); expect(calls[0].values).toEqual(['profile', 'account']);
    expect(calls[1].text).toContain('id = $1 AND account_id = $2');
    expect(calls[2].text).toContain('id = $1 AND account_id = $2'); expect(calls[3].text).toContain('id = $1 AND account_id = $2');
    expect(calls.flatMap((call) => call.values).join(' ')).not.toMatch(/token|secret|password|otp/i);
  });
});

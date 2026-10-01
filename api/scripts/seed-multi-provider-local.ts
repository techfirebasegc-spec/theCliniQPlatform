import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/infrastructure/database.js';
import { PostgresAuditRepository } from '../src/modules/audit/postgres-audit-repository.js';
import { PostgresAvailabilityRepository } from '../src/modules/availability/postgres-availability-repository.js';
import { AvailabilityService } from '../src/modules/availability/availability.js';
import { PostgresMembershipRepository } from '../src/modules/memberships/postgres-membership-repository.js';
import { TenantContextService } from '../src/modules/memberships/memberships.js';
import { PostgresServiceExposureRepository } from '../src/modules/service-exposures/postgres-service-exposure-repository.js';
import { ServiceExposureService } from '../src/modules/service-exposures/service-exposures.js';
import { PostgresServiceOfferingRepository } from '../src/modules/service-offerings/postgres-service-offering-repository.js';
import { ServiceOfferingService, type ServiceOfferingOwner, type ServiceOfferingVersion } from '../src/modules/service-offerings/service-offerings.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const environmentFile = resolve(scriptDirectory, '..', '.env');
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

const doctorA = {
  accountId: '3fd29795-1b1d-4c44-9ce7-74f0ce9b1f5f', profileId: 'd04b5c8b-0d2c-4455-97b4-874a8f47b0d9',
  displayName: 'Dr. Marketplace Fixture A', serviceName: 'Fixture Doctor A Consultation',
};
const doctorB = {
  accountId: 'cbaf2a19-83d4-4fcc-b20f-14ca8345ed4c', profileId: 'e4efedb4-e92e-4b85-a702-22cab324caa0',
  displayName: 'Dr. Marketplace Fixture B', serviceName: 'Fixture Doctor B Consultation',
};
const clinicB = {
  tenantId: '30d3c4e0-5fbb-4e04-86da-ddbd23d38d1d', ownerAccountId: '01765d0a-f38b-4d40-bd17-16140f2b404f', membershipId: '2ee4db51-7f01-48da-b3f3-6ae9cd4c9728', clinicId: '3a2d59f4-bbdf-4b58-bf16-5e09d3b3aed1',
  legalName: 'Marketplace Fixture Clinic B Pvt Ltd', displayName: 'Marketplace Fixture Clinic B', serviceName: 'Fixture Clinic B Consultation',
};
const fixtureMarker = 'LOCAL_MULTI_PROVIDER_FIXTURE_V1';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('LOCAL_FIXTURE_DATABASE_URL_REQUIRED');
const target = new URL(databaseUrl);
if (target.hostname !== '127.0.0.1' || target.port !== '5433' || target.pathname !== '/cliniq_platform') throw new Error('LOCAL_FIXTURE_REFUSES_NON_LOCAL_DATABASE');

type Database = ReturnType<typeof createDatabase>;
type Provider = { accountId: string; profileId?: string; clinicId?: string; tenantId?: string; serviceName: string; kind: 'DOCTOR' | 'CLINIC' };
type FixtureResult = { doctorA: Result; doctorB: Result; clinicB: Result };
type Result = { providerId: string; serviceExposureId: string; availabilityConfigurationId: string };

async function main(): Promise<void> {
  const database = createDatabase({ DATABASE_URL: databaseUrl });
  try {
    const actorAccountId = await ensurePrerequisites(database);
    const audit = new PostgresAuditRepository(database);
    const memberships = new PostgresMembershipRepository(database);
    const context = new TenantContextService(memberships, audit);
    const offerings = new ServiceOfferingService(new PostgresServiceOfferingRepository(database), context, audit);
    const availability = new AvailabilityService(new PostgresAvailabilityRepository(database), context, audit);
    const exposures = new ServiceExposureService(new PostgresServiceExposureRepository(database), context, audit);

    const doctorAResult = await ensureProvider(database, offerings, availability, exposures, { accountId: doctorA.accountId, profileId: doctorA.profileId, serviceName: doctorA.serviceName, kind: 'DOCTOR' });
    const doctorBResult = await ensureProvider(database, offerings, availability, exposures, { accountId: doctorB.accountId, profileId: doctorB.profileId, serviceName: doctorB.serviceName, kind: 'DOCTOR' });
    const clinicBResult = await ensureProvider(database, offerings, availability, exposures, { accountId: clinicB.ownerAccountId, clinicId: clinicB.clinicId, tenantId: clinicB.tenantId, serviceName: clinicB.serviceName, kind: 'CLINIC' });
    const result: FixtureResult = { doctorA: doctorAResult, doctorB: doctorBResult, clinicB: clinicBResult };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.close();
  }
}

async function ensurePrerequisites(database: Database): Promise<string> {
  return database.transaction(async (transaction) => {
    const owner = (await transaction.query<{ account_id: string }>("SELECT membership.account_id FROM tenant_memberships membership JOIN tenants tenant ON tenant.id=membership.tenant_id WHERE membership.role_key='CLINIC_OWNER' AND membership.status='ACTIVE' AND tenant.status='ACTIVE' ORDER BY membership.accepted_at NULLS LAST, membership.created_at LIMIT 1 FOR UPDATE", [])).rows[0];
    if (!owner) throw new Error('LOCAL_FIXTURE_ACTIVE_CLINIC_OWNER_REQUIRED');
    const actor = String(owner.account_id);
    for (const doctor of [doctorA, doctorB]) {
      await transaction.query('INSERT INTO accounts (id,status,display_name,created_by_account_id,updated_by_account_id) VALUES ($1,\'ACTIVE\',$2,$3,$3) ON CONFLICT (id) DO NOTHING', [doctor.accountId, doctor.displayName, actor]);
      await transaction.query("INSERT INTO doctor_profiles (id,account_id,status,display_name,professional_verification_status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'ACTIVE',$3,'VERIFIED',$4,$4) ON CONFLICT (id) DO NOTHING", [doctor.profileId, doctor.accountId, doctor.displayName, actor]);
    }
    await transaction.query("INSERT INTO accounts (id,status,display_name,created_by_account_id,updated_by_account_id) VALUES ($1,'ACTIVE','Local Clinic B Owner',$2,$2) ON CONFLICT (id) DO NOTHING", [clinicB.ownerAccountId, actor]);
    await transaction.query("INSERT INTO tenants (id,status,created_by_account_id,updated_by_account_id) VALUES ($1,'ACTIVE',$2,$2) ON CONFLICT (id) DO NOTHING", [clinicB.tenantId, actor]);
    await transaction.query("INSERT INTO tenant_memberships (id,tenant_id,account_id,role_key,status,accepted_at) VALUES ($1,$2,$3,'CLINIC_OWNER','ACTIVE',current_timestamp) ON CONFLICT (id) DO NOTHING", [clinicB.membershipId, clinicB.tenantId, clinicB.ownerAccountId]);
    await transaction.query("INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'ACTIVE',$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING", [clinicB.clinicId, clinicB.tenantId, clinicB.legalName, clinicB.displayName, actor]);
    await verifyPrerequisites(transaction, actor);
    return actor;
  });
}

async function verifyPrerequisites(database: { query: Database['query'] }, actor: string): Promise<void> {
  const doctors = await database.query<{ id: string }>("SELECT id FROM doctor_profiles WHERE id = ANY($1::uuid[]) AND status='ACTIVE' AND professional_verification_status='VERIFIED'", [[doctorA.profileId, doctorB.profileId]]);
  const clinic = await database.query<{ id: string }>("SELECT clinic.id FROM clinics clinic JOIN tenants tenant ON tenant.id=clinic.tenant_id JOIN tenant_memberships membership ON membership.tenant_id=tenant.id WHERE clinic.id=$1 AND tenant.id=$2 AND clinic.status='ACTIVE' AND tenant.status='ACTIVE' AND membership.account_id=$3 AND membership.role_key='CLINIC_OWNER' AND membership.status='ACTIVE'", [clinicB.clinicId, clinicB.tenantId, clinicB.ownerAccountId]);
  if (doctors.rows.length !== 2 || clinic.rows.length !== 1) throw new Error('LOCAL_FIXTURE_PREREQUISITE_CONFLICT');
}

async function ensureProvider(database: Database, offerings: ServiceOfferingService, availability: AvailabilityService, exposures: ServiceExposureService, provider: Provider): Promise<Result> {
  const owner: ServiceOfferingOwner = provider.kind === 'DOCTOR'
    ? { kind: 'DOCTOR', doctorProfileId: provider.profileId! }
    : { kind: 'CLINIC', clinicId: provider.clinicId!, tenantId: provider.tenantId! };
  const offering = await findOffering(database, owner, provider.serviceName)
    ?? await offerings.create(provider.accountId, { owner: provider.kind === 'DOCTOR' ? { kind: 'DOCTOR', doctorProfileId: provider.profileId! } : { kind: 'CLINIC', clinicId: provider.clinicId! }, name: provider.serviceName, description: fixtureMarker, status: 'ACTIVE' });
  const version = await findVersion(database, offering.id)
    ?? await offerings.createVersion(provider.accountId, offering.id, { versionNumber: 1, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), currency: 'INR', amountMinor: 50000n });
  await ensureReservationPolicy(database, version.id, provider.accountId);
  const configurationId = await findAvailabilityConfiguration(database, version.id)
    ?? (await availability.create(provider.accountId, version.id, {
      providerTimezone: 'Asia/Kolkata', slotDurationSeconds: 1800, bufferBeforeSeconds: 0, bufferAfterSeconds: 0,
      capacity: 2, bookingLeadTimeSeconds: 0, bookingHorizonSeconds: 31_536_000,
      rules: [{ recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), windows: [{ kind: 'WORKING', weekday: 1, startSeconds: 36_000, endSeconds: 46_800 }, { kind: 'WORKING', weekday: 2, startSeconds: 36_000, endSeconds: 46_800 }, { kind: 'WORKING', weekday: 3, startSeconds: 36_000, endSeconds: 46_800 }] }],
    })).id;
  let exposure = await findExposure(database, offering.id);
  if (!exposure) exposure = await exposures.create(provider.accountId, offering.id);
  if (exposure.status !== 'PUBLISHED') exposure = await exposures.publish(provider.accountId, exposure.id);
  return { providerId: provider.kind === 'DOCTOR' ? provider.profileId! : provider.clinicId!, serviceExposureId: exposure.id, availabilityConfigurationId: configurationId };
}

async function findOffering(database: Database, owner: ServiceOfferingOwner, name: string) {
  const result = await database.query<{ id: string; owner_doctor_profile_id: string | null; owner_clinic_id: string | null; tenant_id: string | null; name: string; description: string | null; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }>('SELECT offering.id,offering.owner_doctor_profile_id,offering.owner_clinic_id,clinic.tenant_id,offering.name,offering.description,offering.status FROM service_offerings offering LEFT JOIN clinics clinic ON clinic.id=offering.owner_clinic_id WHERE offering.owner_doctor_profile_id IS NOT DISTINCT FROM $1 AND offering.owner_clinic_id IS NOT DISTINCT FROM $2 AND offering.name=$3 AND offering.description=$4', [owner.kind === 'DOCTOR' ? owner.doctorProfileId : null, owner.kind === 'CLINIC' ? owner.clinicId : null, name, fixtureMarker]);
  const row = result.rows[0];
  return row ? { id: row.id, owner, name: row.name, description: row.description, status: row.status } : null;
}

async function findVersion(database: Database, offeringId: string): Promise<ServiceOfferingVersion | null> {
  const result = await database.query<{ id: string; version_number: number; status: 'DRAFT' | 'ACTIVE' | 'RETIRED'; effective_from: Date; effective_to: Date | null; currency: string; amount_minor: string }>('SELECT version.id,version.version_number,version.status,version.effective_from,version.effective_to,price.currency,price.amount_minor FROM service_offering_versions version JOIN service_offering_prices price ON price.service_offering_version_id=version.id WHERE version.service_offering_id=$1 AND version.version_number=1', [offeringId]);
  const row = result.rows[0];
  return row ? { id: row.id, serviceOfferingId: offeringId, versionNumber: row.version_number, status: row.status, effectiveFrom: new Date(row.effective_from), effectiveTo: row.effective_to ? new Date(row.effective_to) : null, price: { currency: row.currency, amountMinor: BigInt(row.amount_minor) } } : null;
}

async function findAvailabilityConfiguration(database: Database, versionId: string): Promise<string | null> {
  const result = await database.query<{ id: string }>("SELECT id FROM availability_configurations WHERE service_offering_version_id=$1 AND status='ACTIVE'", [versionId]);
  return result.rows[0]?.id ?? null;
}

async function ensureReservationPolicy(database: Database, versionId: string, actorAccountId: string): Promise<void> {
  await database.transaction(async (transaction) => {
    const existing = await transaction.query<{ id: string }>('SELECT id FROM service_offering_version_reservation_policies WHERE service_offering_version_id=$1 FOR UPDATE', [versionId]);
    if (!existing.rows[0]) await transaction.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), versionId, 900, actorAccountId]);
  });
}

async function findExposure(database: Database, offeringId: string) {
  const result = await database.query<{ id: string; status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED' }>('SELECT id,status FROM service_exposures WHERE service_offering_id=$1', [offeringId]);
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status } : null;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'LOCAL_FIXTURE_FAILED');
  process.exitCode = 1;
});

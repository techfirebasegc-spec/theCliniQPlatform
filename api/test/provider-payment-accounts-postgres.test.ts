import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PostgresProviderPaymentAccountRepository } from '../src/modules/financial/provider-payment-accounts.js';

const databaseUrl = process.env.DATABASE_URL;
let pool: Pool | undefined;

describe.skipIf(!databaseUrl)('theCliniQ Phase 6.3A PostgreSQL provider payment accounts', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== 'cliniq_phase63_provider_payment_accounts_verify') throw new Error('Refusing Phase 6.3A verification outside cliniq_phase63_provider_payment_accounts_verify.');
    const schema = await pool.query("SELECT to_regclass('provider_payment_accounts') AS accounts");
    if (!schema.rows[0]?.accounts) throw new Error('Phase 6.3A provider payment account migration is not applied.');
  });

  afterAll(async () => { await pool?.end(); });

  it('creates doctor and clinic payment accounts and resolves active and settlement-ready records', async () => withFixture(async (client, fixture) => {
    const repository = repositoryFor(client);
    const doctor = await repository.create(account({ providerKind: 'DOCTOR', doctorProfileId: fixture.doctor }));
    const clinic = await repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'clinic-beneficiary' }));
    expect(doctor.doctorProfileId).toBe(fixture.doctor); expect(doctor.clinicId).toBeNull();
    expect(clinic.clinicId).toBe(fixture.clinic); expect(clinic.doctorProfileId).toBeNull();
    await expect(repository.findActiveDoctor(fixture.doctor, 'RAZORPAY')).resolves.toMatchObject({ id: doctor.id });
    await expect(repository.findSettlementReadyClinic(fixture.clinic, 'RAZORPAY')).resolves.toMatchObject({ id: clinic.id });
    const unverified = await repository.create(account({ providerKind: 'DOCTOR', doctorProfileId: fixture.doctor, paymentProvider: 'OTHER_PROVIDER', verificationStatus: 'PENDING' }));
    await expect(repository.findActiveDoctor(fixture.doctor, 'OTHER_PROVIDER')).resolves.toMatchObject({ id: unverified.id });
    await expect(repository.findSettlementReadyDoctor(fixture.doctor, 'OTHER_PROVIDER')).resolves.toBeNull();
  }));

  it('rejects invalid provider ownership shapes and kind mismatches', async () => withFixture(async (client, fixture) => {
    await expect(client.query("INSERT INTO provider_payment_accounts (id,provider_kind,payment_provider,external_account_reference,status,verification_status) VALUES ($1,'DOCTOR','RAZORPAY','neither','PENDING','NOT_SUBMITTED')", [randomUUID()])).rejects.toThrow();
    await expect(client.query("INSERT INTO provider_payment_accounts (id,provider_kind,doctor_profile_id,clinic_id,payment_provider,external_account_reference,status,verification_status) VALUES ($1,'DOCTOR',$2,$3,'RAZORPAY','both','PENDING','NOT_SUBMITTED')", [randomUUID(), fixture.doctor, fixture.clinic])).rejects.toThrow();
    await expect(client.query("INSERT INTO provider_payment_accounts (id,provider_kind,clinic_id,payment_provider,external_account_reference,status,verification_status) VALUES ($1,'DOCTOR',$2,'RAZORPAY','mismatch','PENDING','NOT_SUBMITTED')", [randomUUID(), fixture.clinic])).rejects.toThrow();
  }));

  it('enforces external-reference and active-provider uniqueness while retaining historical inactive accounts', async () => withFixture(async (client, fixture) => {
    const repository = repositoryFor(client);
    const active = await repository.create(account({ providerKind: 'DOCTOR', doctorProfileId: fixture.doctor, externalAccountReference: 'doctor-current' }));
    await expect(repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'doctor-current' }))).rejects.toThrow();
    await expect(repository.create(account({ providerKind: 'DOCTOR', doctorProfileId: fixture.doctor, externalAccountReference: 'doctor-second' }))).rejects.toThrow();
    await repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'clinic-current' }));
    await expect(repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'clinic-second' }))).rejects.toThrow();
    await client.query("UPDATE provider_payment_accounts SET status='DISABLED' WHERE id=$1", [active.id]);
    await expect(repository.create(account({ providerKind: 'DOCTOR', doctorProfileId: fixture.doctor, externalAccountReference: 'doctor-replacement' }))).resolves.toMatchObject({ status: 'ACTIVE' });
  }));

  it('keeps settlement evidence on the exact historical payment account after replacement', async () => withFixture(async (client, fixture) => {
    const repository = repositoryFor(client);
    const first = await repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'clinic-old' }));
    const allocation = randomUUID(); const settlement = randomUUID();
    await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',1000,'FIXED','{}'::jsonb,'[]'::jsonb,$2)", [allocation, fixture.owner]);
    await client.query("INSERT INTO settlements (id,provider_payment_account_id,allocation_snapshot_id,status,currency,amount_minor,idempotency_key) VALUES ($1,$2,$3,'PENDING_ELIGIBILITY','INR',900,$4)", [settlement, first.id, allocation, `settlement-${settlement}`]);
    await client.query("UPDATE provider_payment_accounts SET status='DISABLED' WHERE id=$1", [first.id]);
    const second = await repository.create(account({ providerKind: 'CLINIC', clinicId: fixture.clinic, externalAccountReference: 'clinic-new' }));
    const saved = await client.query<{ provider_payment_account_id: string }>('SELECT provider_payment_account_id FROM settlements WHERE id=$1', [settlement]);
    expect(saved.rows[0]?.provider_payment_account_id).toBe(first.id); expect(second.id).not.toBe(first.id);
    await expect(client.query("UPDATE provider_payment_accounts SET external_account_reference='rewritten' WHERE id=$1", [first.id])).rejects.toThrow(/identity cannot be changed/);
  }));
});

function repositoryFor(client: PoolClient) { return new PostgresProviderPaymentAccountRepository({ query: async (text, values) => client.query(text, values) }); }
function account(input: Partial<{ id: string; providerKind: 'DOCTOR' | 'CLINIC'; doctorProfileId: string | null; clinicId: string | null; paymentProvider: string; externalAccountReference: string; status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED'; verificationStatus: 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' }>) {
  return { id: input.id ?? randomUUID(), providerKind: input.providerKind ?? 'DOCTOR', doctorProfileId: input.doctorProfileId ?? null, clinicId: input.clinicId ?? null, paymentProvider: input.paymentProvider ?? 'RAZORPAY', externalAccountReference: input.externalAccountReference ?? `beneficiary-${randomUUID()}`, status: input.status ?? 'ACTIVE', verificationStatus: input.verificationStatus ?? 'VERIFIED' };
}
async function withFixture(operation: (client: PoolClient, fixture: { owner: string; doctor: string; clinic: string }) => Promise<void>) {
  const client = await pool!.connect();
  try { await client.query('BEGIN'); const owner = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), clinic = randomUUID(), tenant = randomUUID();
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [owner, doctorAccount]);
    await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
    await client.query("INSERT INTO tenants (id,status,created_by_account_id) VALUES ($1,'ACTIVE',$2)", [tenant, owner]);
    await client.query("INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id) VALUES ($1,$2,'ACTIVE','Clinic legal','Clinic',$3)", [clinic, tenant, owner]);
    await operation(client, { owner, doctor, clinic });
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}

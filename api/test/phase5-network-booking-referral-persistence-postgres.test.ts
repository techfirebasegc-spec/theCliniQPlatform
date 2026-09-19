import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
let pool: Pool | undefined;

/** Dedicated disposable verification only. Sequential fixtures roll back; committed concurrency fixtures are reset from this exact disposable database. */
describe.skipIf(!enabled)('theCliniQ Phase 5.8 network booking/referral PostgreSQL guards', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== 'cliniq_phase5_network_booking_referral_verify') {
      throw new Error('Refusing Phase 5.8 verification outside cliniq_phase5_network_booking_referral_verify.');
    }
    const schema = await pool.query(`SELECT to_regclass('queue_windows') AS queue_windows,
      to_regclass('queue_entries') AS queue_entries,
      to_regclass('patient_clinic_booking_authorizations') AS delegated_authorizations,
      to_regclass('appointment_referrals') AS referrals,
      to_regclass('network_booking_contexts') AS booking_contexts`);
    if (Object.values(schema.rows[0] ?? {}).some((value) => !value)) {
      throw new Error('Phase 5.8 network booking/referral persistence migration is not applied.');
    }
    await resetDisposableFixtureData();
  });

  afterAll(async () => { await resetDisposableFixtureData(); await pool?.end(); });

  it('enforces queue capacity, position uniqueness, queue-window context, and scheduling context through direct SQL', async () => {
    await inFixture(async (client, fixture) => {
      const first = await insertQueueIntent(client, fixture, 'queue-first');
      const second = await insertQueueIntent(client, fixture, 'queue-second');
      const third = await insertQueueIntent(client, fixture, 'queue-third');
      const firstEntry = await insertQueueEntry(client, fixture, first, 1);
      await attachQueueEntry(client, first, firstEntry);
      const secondEntry = await insertQueueEntry(client, fixture, second, 999);
      await attachQueueEntry(client, second, secondEntry);
      const positions = await client.query<{ queue_position: number }>('SELECT queue_position FROM queue_entries WHERE id IN ($1,$2) ORDER BY queue_position', [firstEntry, secondEntry]);
      expect(positions.rows.map((row) => row.queue_position)).toEqual([1, 2]);
      await expectFailure(client, 'queue_position_immutable', () => client.query('UPDATE queue_entries SET queue_position=999 WHERE id=$1', [secondEntry]), /queue entry evidence is immutable/);
      await client.query('SET CONSTRAINTS queue_entries_intent_attachment_integrity, queue_entries_status_integrity IMMEDIATE');
      await client.query('SET CONSTRAINTS queue_entries_intent_attachment_integrity, queue_entries_status_integrity DEFERRED');
      await expectFailure(client, 'queue_status_called_without_in_progress_appointment', async () => { await client.query("UPDATE queue_entries SET queue_status='CALLED' WHERE id=$1", [firstEntry]); await client.query('SET CONSTRAINTS queue_entries_status_integrity IMMEDIATE'); }, /queue entry status is inconsistent with appointment lifecycle/);
      await expectFailure(client, 'queue_status_completed_without_completed_appointment', async () => { await client.query("UPDATE queue_entries SET queue_status='COMPLETED' WHERE id=$1", [firstEntry]); await client.query('SET CONSTRAINTS queue_entries_status_integrity IMMEDIATE'); }, /queue entry status is inconsistent with appointment lifecycle/);
      await expectFailure(client, 'queue_status_cancelled_without_cancelled_context', async () => { await client.query("UPDATE queue_entries SET queue_status='CANCELLED' WHERE id=$1", [firstEntry]); await client.query('SET CONSTRAINTS queue_entries_status_integrity IMMEDIATE'); }, /queue entry status is inconsistent with appointment lifecycle/);
      await expectFailure(client, 'queue_capacity_release_without_lifecycle', async () => { await client.query("UPDATE queue_entries SET capacity_status='RELEASED',released_at=current_timestamp,release_reason_category='CANCELLED' WHERE id=$1", [firstEntry]); await client.query('SET CONSTRAINTS queue_entries_capacity_lifecycle_integrity IMMEDIATE'); }, /queue entry capacity release is inconsistent with appointment lifecycle/);
      await expectFailure(client, 'capacity_exceeded', () => insertQueueEntry(client, fixture, third, 3), /queue window capacity is exceeded/);
      const unattachedIntent = await insertQueueIntent(client, fixture, 'queue-unattached', fixture.closedQueueWindow);
      await client.query("INSERT INTO queue_entries (id,queue_window_id,appointment_intent_id,patient_account_id,booking_actor_account_id,maximum_capacity,queue_position) VALUES ($1,$2,$3,$4,$5,2,3)", [randomUUID(), fixture.closedQueueWindow, unattachedIntent, fixture.patient, fixture.patient]);
      await expectFailure(client, 'queue_entry_unattached', () => client.query('SET CONSTRAINTS queue_entries_intent_attachment_integrity IMMEDIATE'), /queue entry must be attached/);
      await expectFailure(client, 'queue_entry_delete', () => client.query('DELETE FROM queue_entries WHERE id=$1', [firstEntry]), /queue entry evidence cannot be deleted/);
      await expectFailure(client, 'queue_context_mutation', () => client.query("UPDATE appointment_intents SET scheduling_mode='FIXED_SLOT' WHERE id=$1", [first]), /appointment intent scheduling context is immutable|appointment_intents_queue_context_check/);
      await expectFailure(client, 'queue_window_capacity_snapshot', () => client.query('UPDATE queue_windows SET maximum_capacity=3 WHERE id=$1', [fixture.queueWindow]), /queue window policy snapshot is inconsistent|queue window context is immutable/);
      await expectFailure(client, 'queue_window_transition', () => client.query("UPDATE queue_windows SET status='OPEN' WHERE id=$1", [fixture.closedQueueWindow]), /queue window transition is invalid/);
      await expectFailure(client, 'queue_policy_update', () => client.query('UPDATE service_offering_version_queue_policies SET maximum_capacity=3 WHERE id=$1', [fixture.queuePolicy]), /queue policy cannot be changed/);
      await expectFailure(client, 'queue_policy_delete', () => client.query('DELETE FROM service_offering_version_queue_policies WHERE id=$1', [fixture.queuePolicy]), /queue policy cannot be changed/);
    });
  });

  it('serializes two genuinely concurrent final-capacity queue entries', async () => {
    const setup = await pool!.connect();
    let fixture!: Fixture;
    try {
      await setup.query('BEGIN');
      fixture = await seed(setup, 1);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      setup.release();
    }

    const first = await pool!.connect();
    const second = await pool!.connect();
    const readyToInsert = concurrentBarrier(2);
    try {
      const outcomes = await Promise.allSettled([
        insertFinalCapacityQueueEntry(first, fixture, 'queue-capacity-a', 1, 1, readyToInsert),
        insertFinalCapacityQueueEntry(second, fixture, 'queue-capacity-b', 2, 1, readyToInsert),
      ]);
      const committed = outcomes.filter((outcome): outcome is PromiseFulfilledResult<ConcurrentQueueEntry> => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(committed).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const active = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM queue_entries WHERE queue_window_id=$1 AND capacity_status='ACTIVE'", [fixture.queueWindow]);
      expect(active.rows[0]?.count).toBe('1');
    } finally {
      await Promise.all([
        first.query('ROLLBACK').catch(() => undefined),
        second.query('ROLLBACK').catch(() => undefined),
      ]);
      first.release();
      second.release();
      await resetDisposableFixtureData();
    }
  });

  it('assigns distinct deterministic queue positions under concurrent insertion', async () => {
    const setup = await pool!.connect();
    let fixture!: Fixture;
    try { await setup.query('BEGIN'); fixture = await seed(setup, 2); await setup.query('COMMIT'); }
    catch (error) { await setup.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { setup.release(); }
    const first = await pool!.connect(); const second = await pool!.connect(); const readyToInsert = concurrentBarrier(2);
    try {
      const outcomes = await Promise.all([
        insertFinalCapacityQueueEntry(first, fixture, 'queue-position-a', 999, 2, readyToInsert),
        insertFinalCapacityQueueEntry(second, fixture, 'queue-position-b', 500, 2, readyToInsert),
      ]);
      const positions = await pool!.query<{ queue_position: number }>('SELECT queue_position FROM queue_entries WHERE id IN ($1,$2) ORDER BY queue_position', outcomes.map((outcome) => outcome.entryId));
      expect(positions.rows.map((row) => row.queue_position)).toEqual([1, 2]);
    } finally {
      await Promise.all([first.query('ROLLBACK').catch(() => undefined), second.query('ROLLBACK').catch(() => undefined)]);
      first.release(); second.release(); await resetDisposableFixtureData();
    }
  });

  it('enforces delegated authorization lifecycle, immutable scope, terminal protection, and single-use intent evidence', async () => {
    await inFixture(async (client, fixture) => {
      const active = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      await expectFailure(client, 'authorization_scope_immutable', () => client.query("UPDATE patient_clinic_booking_authorizations SET scope_fingerprint='changed' WHERE id=$1", [active]), /scope is immutable/);
      await expectFailure(client, 'authorization_revocation_actor', () => client.query("UPDATE patient_clinic_booking_authorizations SET status='REVOKED',revoked_at=current_timestamp,revoked_by_account_id=$2,revocation_reason_category='CLINIC' WHERE id=$1", [active, fixture.clinicAccountA]), /patient delegated booking authorization revocation requires patient actor/);
      await client.query("UPDATE patient_clinic_booking_authorizations SET status='REVOKED',revoked_at=current_timestamp,revoked_by_account_id=$2,revocation_reason_category='PATIENT' WHERE id=$1", [active, fixture.patient]);
      await expectFailure(client, 'authorization_terminal_reactivation', () => client.query("UPDATE patient_clinic_booking_authorizations SET status='ACTIVE',revoked_at=NULL,revoked_by_account_id=NULL,revocation_reason_category=NULL WHERE id=$1", [active]), /cannot reactivate|transition is invalid/);
      await expectFailure(client, 'authorization_delete', () => client.query('DELETE FROM patient_clinic_booking_authorizations WHERE id=$1', [active]), /cannot be deleted/);
      const unrelatedQueueWindow = await insertUnrelatedQueueWindow(client, fixture);
      await expectFailure(client, 'authorization_queue_scope_substitution', () => insertDelegatedQueueAuthorization(client, fixture, unrelatedQueueWindow), /queue window is inconsistent/);
      const consumedIntent = await insertFixedIntent(client, fixture, 'authorization-initial-consumed');
      await expectFailure(client, 'authorization_initial_consumed', () => insertNonActiveDelegatedAuthorization(client, fixture, 'CONSUMED', consumedIntent), /must begin active/);
      await expectFailure(client, 'authorization_initial_revoked', () => insertNonActiveDelegatedAuthorization(client, fixture, 'REVOKED'), /must begin active/);
      await expectFailure(client, 'authorization_initial_expired', () => insertNonActiveDelegatedAuthorization(client, fixture, 'EXPIRED'), /must begin active/);
      const expired = await insertExpiredActiveDelegatedAuthorization(client, fixture);
      const expiredIntent = await insertFixedIntent(client, fixture, 'authorization-expired');
      await expectFailure(client, 'authorization_expired_consumption', () => client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [expired, expiredIntent, fixture.clinicAccountA]), /expired patient delegated booking authorization cannot be consumed/);
      const orphan = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      const orphanIntent = await insertClinicDoctorIntent(client, fixture, 'authorization-orphan');
      await expectFailure(client, 'authorization_consumption_requires_context', async () => { await client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [orphan, orphanIntent, fixture.clinicAccountA]); await client.query('SET CONSTRAINTS delegated_authorizations_consumption_context_integrity IMMEDIATE'); }, /consumed delegated authorization requires exact network booking context/);
      const consumable = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      const intent = await insertFixedIntent(client, fixture, 'delegated-consumption');
      await client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [consumable, intent, fixture.clinicAccountA]);
      const duplicate = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      await expectFailure(client, 'authorization_single_use', () => client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [duplicate, intent, fixture.clinicAccountA]), /duplicate key|consuming_appointment_intent_id_key/);
      const queueAuthorization = await insertDelegatedQueueAuthorization(client, fixture, fixture.queueWindow);
      const queueIntent = await insertIntent(client, fixture, 'queue-context-missing-entry', 'CLINIC_DOCTOR', 'BOOK', 'QUEUE', fixture.queueWindow);
      await client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [queueAuthorization, queueIntent, fixture.clinicAccountA]);
      await expectFailure(client, 'queue_network_context_requires_entry', async () => { await insertQueueNetworkContextWithoutEntry(client, fixture, queueIntent, queueAuthorization); await client.query('SET CONSTRAINTS network_booking_contexts_commit_integrity IMMEDIATE'); }, /queue network booking context requires exact queue entry/);
    });
  });

  it('enforces referral lifecycle, pending uniqueness, and append-only consent evidence', async () => {
    await inFixture(async (client, fixture) => {
      const referral = await insertReferral(client, fixture, 'purpose-a');
      await expectFailure(client, 'invalid_referral_start', () => client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [referral, fixture.clinicAccountB]), /transition is invalid/);
      const consent = randomUUID();
      await client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'GRANTED',$3,$5)", [consent, referral, fixture.patient, fixture.patientProfile, 'purpose-a']);
      await client.query("UPDATE appointment_referrals SET status='PENDING_RECEIVING_CLINIC' WHERE id=$1", [referral]);
      await expectFailure(client, 'referral_receiving_actor', () => client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [referral, fixture.patient]), /appointment referral receiving action requires authorized clinic actor/);
      await expectFailure(client, 'referral_rejecting_actor', () => client.query("UPDATE appointment_referrals SET status='REJECTED',rejected_at=current_timestamp,rejected_by_account_id=$2 WHERE id=$1", [referral, fixture.patient]), /appointment referral receiving action requires authorized clinic actor/);
      await client.query("UPDATE appointment_referrals SET status='REJECTED',rejected_at=current_timestamp,rejected_by_account_id=$2 WHERE id=$1", [referral, fixture.clinicAccountB]);
      await expectFailure(client, 'terminal_referral_reactivation', () => client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2,rejected_at=NULL,rejected_by_account_id=NULL WHERE id=$1", [referral, fixture.clinicAccountB]), /cannot reactivate|transition is invalid/);
      await expectFailure(client, 'consent_update', () => client.query("UPDATE referral_consent_events SET event_type='WITHDRAWN' WHERE id=$1", [consent]), /cannot be changed/);
      await expectFailure(client, 'consent_delete', () => client.query('DELETE FROM referral_consent_events WHERE id=$1', [consent]), /cannot be changed/);
      await expectFailure(client, 'referral_delete', () => client.query('DELETE FROM appointment_referrals WHERE id=$1', [referral]), /cannot be deleted/);
      const expired = await insertReferral(client, fixture, 'purpose-expired');
      await expectFailure(client, 'expired_referral_contradictory_evidence', () => client.query("UPDATE appointment_referrals SET status='EXPIRED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [expired, fixture.clinicAccountB]), /appointment_referrals_check/);
      await client.query("UPDATE appointment_referrals SET status='EXPIRED' WHERE id=$1", [expired]);
      const invalidPendingEvidence = await insertReferral(client, fixture, 'purpose-invalid-pending-evidence');
      await expectFailure(client, 'pending_referral_contradictory_evidence', () => client.query("UPDATE appointment_referrals SET accepted_by_account_id=$2 WHERE id=$1", [invalidPendingEvidence, fixture.clinicAccountB]), /appointment_referrals_check/);
      await expectFailure(client, 'mismatched_consent', () => client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'GRANTED',$3,'wrong-scope')", [randomUUID(), referral, fixture.patient, fixture.patientProfile]), /consent evidence is inconsistent/);
      const pending = await insertReferral(client, fixture, 'purpose-b');
      await expectFailure(client, 'pending_referral_unique', () => insertReferral(client, fixture, 'purpose-b'), /duplicate key|appointment_referrals_pending_unique/);
      expect(pending).toBeDefined();
      const orphanReferral = await insertReferral(client, fixture, 'purpose-orphan');
      await client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'GRANTED',$3,$5)", [randomUUID(), orphanReferral, fixture.patient, fixture.patientProfile, 'purpose-orphan']);
      await client.query("UPDATE appointment_referrals SET status='PENDING_RECEIVING_CLINIC' WHERE id=$1", [orphanReferral]);
      await client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [orphanReferral, fixture.clinicAccountB]);
      const orphanIntent = await insertClinicReferralIntent(client, fixture, 'referral-orphan');
      await expectFailure(client, 'referral_consumption_requires_context', async () => { await client.query("UPDATE appointment_referrals SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp WHERE id=$1", [orphanReferral, orphanIntent]); await client.query('SET CONSTRAINTS appointment_referrals_consumption_context_integrity IMMEDIATE'); }, /consumed referral requires exact network booking context/);
      const withdrawn = await insertReferral(client, fixture, 'purpose-withdrawn');
      await client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'GRANTED',$3,$5)", [randomUUID(), withdrawn, fixture.patient, fixture.patientProfile, 'purpose-withdrawn']);
      await client.query("UPDATE appointment_referrals SET status='PENDING_RECEIVING_CLINIC' WHERE id=$1", [withdrawn]);
      await client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'WITHDRAWN',$3,$5)", [randomUUID(), withdrawn, fixture.patient, fixture.patientProfile, 'purpose-withdrawn']);
      await client.query("UPDATE appointment_referrals SET status='WITHDRAWN',withdrawn_at=current_timestamp,withdrawn_by_account_id=$2,withdrawal_reason_category='PATIENT' WHERE id=$1", [withdrawn, fixture.patient]);
      await client.query('SET CONSTRAINTS referral_consent_events_state_integrity, appointment_referral_consent_transition_integrity IMMEDIATE');
      await expectFailure(client, 'withdrawn_referral_acceptance', () => client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2,withdrawn_at=NULL,withdrawn_by_account_id=NULL,withdrawal_reason_category=NULL WHERE id=$1", [withdrawn, fixture.clinicAccountB]), /transition is invalid|withdrawn referral consent prevents acceptance or consumption/);
    });
  });

  it('rejects mismatched and mutable network booking contexts through direct SQL', async () => {
    await inFixture(async (client, fixture) => {
      const authorization = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      const intent = await insertClinicDoctorIntent(client, fixture, 'network-context');
      await client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [authorization, intent, fixture.clinicAccountA]);
      await expectFailure(client, 'network_context_mismatch', () => insertNetworkContext(client, fixture, intent, authorization, fixture.clinicAccountB), /network booking context is inconsistent|delegated network booking context is inconsistent/);
      const context = await insertNetworkContext(client, fixture, intent, authorization, fixture.clinicAccountA);
      await client.query('UPDATE appointment_intents SET network_booking_context_id=$2 WHERE id=$1', [intent, context]);
      await client.query('SET CONSTRAINTS network_booking_contexts_commit_integrity IMMEDIATE');
      await expectFailure(client, 'network_context_update', () => client.query('UPDATE network_booking_contexts SET booking_actor_account_id=$2 WHERE id=$1', [context, fixture.clinicAccountB]), /cannot be changed/);
      await expectFailure(client, 'network_context_delete', () => client.query('DELETE FROM network_booking_contexts WHERE id=$1', [context]), /cannot be changed/);
      const alternateBook = await insertAlternateBookCapability(client, fixture);
      const secondAuthorization = await insertDelegatedAuthorization(client, fixture, 'ACTIVE');
      const secondIntent = await insertClinicDoctorIntent(client, fixture, 'network-provider-substitution');
      await client.query("UPDATE patient_clinic_booking_authorizations SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp,consumed_by_account_id=$3 WHERE id=$1", [secondAuthorization, secondIntent, fixture.clinicAccountA]);
      await expectFailure(client, 'delegated_network_provider_substitution', () => insertNetworkContext(client, fixture, secondIntent, secondAuthorization, fixture.clinicAccountA, alternateBook), /delegated network booking context is inconsistent/);

      const referral = await insertReferral(client, fixture, 'context-purpose');
      await client.query("INSERT INTO referral_consent_events (id,appointment_referral_id,patient_account_id,patient_profile_id,event_type,actor_account_id,scope_fingerprint) VALUES ($1,$2,$3,$4,'GRANTED',$3,$5)", [randomUUID(), referral, fixture.patient, fixture.patientProfile, 'context-purpose']);
      await client.query("UPDATE appointment_referrals SET status='PENDING_RECEIVING_CLINIC' WHERE id=$1", [referral]);
      await client.query("UPDATE appointment_referrals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [referral, fixture.clinicAccountB]);
      const referralIntent = await insertClinicReferralIntent(client, fixture, 'network-referral-substitution');
      await client.query("UPDATE appointment_referrals SET status='CONSUMED',consuming_appointment_intent_id=$2,consumed_at=current_timestamp WHERE id=$1", [referral, referralIntent]);
      const alternateRefer = await insertReverseReferCapability(client, fixture);
      await expectFailure(client, 'referral_network_relationship_substitution', () => insertReferralNetworkContext(client, fixture, referralIntent, referral, alternateRefer), /referral network booking context is inconsistent/);
    });
  });

  it('enforces policy-version immutable fields and lifecycle transitions through direct SQL', async () => {
    await inFixture(async (client, fixture) => {
      await client.query("UPDATE patient_delegated_booking_authorization_policy_versions SET status='APPROVED' WHERE id=$1", [fixture.delegatedPolicy]);
      await expectFailure(client, 'policy_immutable', () => client.query('UPDATE patient_delegated_booking_authorization_policy_versions SET expiry_seconds=301 WHERE id=$1', [fixture.delegatedPolicy]), /policy version is immutable/);
      await expectFailure(client, 'policy_invalid_transition', () => client.query("UPDATE patient_delegated_booking_authorization_policy_versions SET status='DRAFT' WHERE id=$1", [fixture.delegatedPolicy]), /policy version transition is invalid/);
      await client.query("UPDATE patient_delegated_booking_authorization_policy_versions SET status='RETIRED' WHERE id=$1", [fixture.delegatedPolicy]);
    });
  });
});

async function inFixture(work: (client: PoolClient, fixture: Fixture) => Promise<void>) {
  const client = await pool!.connect();
  try { await client.query('BEGIN'); await work(client, await seed(client)); }
  finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}

async function resetDisposableFixtureData() {
  if (pool) await pool.query('TRUNCATE TABLE accounts, retention_policy_versions CASCADE');
}

async function expectFailure(client: PoolClient, name: string, work: () => Promise<unknown>, expected: RegExp) {
  await client.query(`SAVEPOINT ${name}`);
  try { await work(); throw new Error(`Expected PostgreSQL rejection for ${name}.`); }
  catch (error) { expect(error).toMatchObject({ message: expect.stringMatching(expected) }); }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); }
}

type Fixture = Record<'patient' | 'patientProfile' | 'doctor' | 'doctorAccount' | 'clinicAccountA' | 'clinicAccountB' | 'clinicA' | 'clinicB' | 'tenantA' | 'tenantB' | 'offering' | 'exposure' | 'clinicOffering' | 'clinicExposure' | 'version' | 'price' | 'clinicVersion' | 'clinicPrice' | 'configuration' | 'queuePolicy' | 'queueWindow' | 'closedQueueWindow' | 'delegatedPolicy' | 'referralPolicy' | 'retentionPolicy' | 'clinicDoctorConnection' | 'clinicClinicConnection' | 'bookCapability' | 'bookProposal' | 'referCapability' | 'referProposal', string>;

async function seed(client: PoolClient, maximumQueueCapacity = 2): Promise<Fixture> {
  const f = Object.fromEntries(['patient','patientProfile','doctor','doctorAccount','clinicAccountA','clinicAccountB','clinicA','clinicB','tenantA','tenantB','offering','exposure','clinicOffering','clinicExposure','version','price','clinicVersion','clinicPrice','configuration','queuePolicy','queueWindow','closedQueueWindow','delegatedPolicy','referralPolicy','retentionPolicy','clinicDoctorConnection','clinicClinicConnection','bookCapability','bookProposal','referCapability','referProposal'].map((key) => [key, randomUUID()])) as Fixture;
  await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE'),($3,'ACTIVE'),($4,'ACTIVE')", [f.patient, f.doctorAccount, f.clinicAccountA, f.clinicAccountB]);
  f.patientProfile = f.patient;
  await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [f.patient]);
  await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [f.doctor, f.doctorAccount]);
  await client.query("INSERT INTO tenants (id,status,created_by_account_id) VALUES ($1,'ACTIVE',$3),($2,'ACTIVE',$4)", [f.tenantA, f.tenantB, f.clinicAccountA, f.clinicAccountB]);
  await client.query("INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id) VALUES ($1,$2,'ACTIVE','A Legal','A',$3),($4,$5,'ACTIVE','B Legal','B',$6)", [f.clinicA, f.tenantA, f.clinicAccountA, f.clinicB, f.tenantB, f.clinicAccountB]);
  await client.query("INSERT INTO tenant_memberships (id,tenant_id,account_id,role_key,status) VALUES ($1,$2,$3,'CLINIC_OWNER','ACTIVE'),($4,$5,$6,'CLINIC_OWNER','ACTIVE')", [randomUUID(), f.tenantA, f.clinicAccountA, randomUUID(), f.tenantB, f.clinicAccountB]);
  await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Phase 5.8 verification','ACTIVE',$3,$3)", [f.offering, f.doctor, f.doctorAccount]);
  await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [f.exposure, f.offering, f.doctor, f.doctorAccount]);
  await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [f.exposure, f.doctorAccount]);
  await client.query("INSERT INTO service_offerings (id,owner_clinic_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Phase 5.8 referral destination','ACTIVE',$3,$3)", [f.clinicOffering, f.clinicB, f.clinicAccountB]);
  await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_clinic_id,tenant_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,$4,'DRAFT',$5,$5)", [f.clinicExposure, f.clinicOffering, f.clinicB, f.tenantB, f.clinicAccountB]);
  await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [f.clinicExposure, f.clinicAccountB]);
  await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',current_timestamp-interval '1 day',$3)", [f.version, f.offering, f.doctorAccount]);
  await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [f.price, f.version, f.doctorAccount]);
  await client.query("INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)", [randomUUID(), f.version, f.doctorAccount]);
  await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',current_timestamp-interval '1 day',$3)", [f.clinicVersion, f.clinicOffering, f.clinicAccountB]);
  await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [f.clinicPrice, f.clinicVersion, f.clinicAccountB]);
  await client.query("INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)", [randomUUID(), f.clinicVersion, f.clinicAccountB]);
  await client.query("INSERT INTO availability_configurations (id,service_offering_version_id,provider_timezone,slot_duration_seconds,buffer_before_seconds,buffer_after_seconds,capacity,booking_lead_time_seconds,booking_horizon_seconds,status,created_by_account_id) VALUES ($1,$2,'Asia/Kolkata',1800,0,0,2,0,1209600,'ACTIVE',$3)", [f.configuration, f.version, f.doctorAccount]);
  await client.query('INSERT INTO service_offering_version_queue_policies (id,service_offering_version_id,maximum_capacity,booking_cutoff_seconds,created_by_account_id) VALUES ($1,$2,$3,0,$4)', [f.queuePolicy, f.version, maximumQueueCapacity, f.doctorAccount]);
  await insertQueueWindow(client, f, f.queueWindow, 'OPEN', maximumQueueCapacity); await insertQueueWindow(client, f, f.closedQueueWindow, 'CLOSED', maximumQueueCapacity);
  const policyVersionBase = Number.parseInt(f.patient.replaceAll('-', '').slice(0, 7), 16);
  await client.query("INSERT INTO patient_delegated_booking_authorization_policy_versions (id,status,version_number,effective_from,expiry_seconds,approved_by_account_id) VALUES ($1,'APPROVED',$2,current_timestamp-interval '1 day',300,$3)", [f.delegatedPolicy, policyVersionBase, f.clinicAccountA]);
  await client.query("INSERT INTO appointment_referral_policy_versions (id,status,version_number,effective_from,expiry_seconds,approved_by_account_id) VALUES ($1,'APPROVED',$2,current_timestamp-interval '1 day',300,$3)", [f.referralPolicy, policyVersionBase + 1, f.clinicAccountA]);
  await client.query("INSERT INTO retention_policy_versions (id,record_category,status,version_number,effective_from,action,policy_data) VALUES ($1,'REFERRAL','APPROVED',$2,current_timestamp-interval '1 day','RETAIN','{}'::jsonb)", [f.retentionPolicy, policyVersionBase + 2]);
  await seedNetwork(client, f);
  return f;
}

async function insertQueueWindow(client: PoolClient, f: Fixture, id: string, status: 'OPEN' | 'CLOSED', maximumQueueCapacity = 2) {
  await client.query(`INSERT INTO queue_windows (id,service_offering_version_id,availability_configuration_id,queue_policy_id,local_start,local_end,derived_start_utc,derived_end_utc,maximum_capacity,booking_cutoff_at,status,created_by_account_id)
    SELECT $1,$2,$3,$4,local_start,local_end,availability_derive_utc('Asia/Kolkata',local_start),availability_derive_utc('Asia/Kolkata',local_end),$5,availability_derive_utc('Asia/Kolkata',local_start),$6,$7
    FROM (SELECT date_trunc('day',current_timestamp AT TIME ZONE 'Asia/Kolkata') + interval '2 days' + CASE WHEN $6='OPEN' THEN interval '9 hours' ELSE interval '11 hours' END AS local_start,date_trunc('day',current_timestamp AT TIME ZONE 'Asia/Kolkata') + interval '2 days' + CASE WHEN $6='OPEN' THEN interval '10 hours' ELSE interval '12 hours' END AS local_end) value`, [id, f.version, f.configuration, f.queuePolicy, maximumQueueCapacity, status, f.doctorAccount]);
}

async function insertQueueIntent(client: PoolClient, f: Fixture, suffix: string, queueWindow = f.queueWindow) { return insertIntent(client, f, suffix, 'PATIENT_PROVIDER', null, 'QUEUE', queueWindow); }
async function insertFixedIntent(client: PoolClient, f: Fixture, suffix: string) { return insertIntent(client, f, suffix, 'PATIENT_PROVIDER', null, 'FIXED_SLOT'); }
async function insertClinicDoctorIntent(client: PoolClient, f: Fixture, suffix: string) { return insertIntent(client, f, suffix, 'CLINIC_DOCTOR', 'BOOK', 'FIXED_SLOT'); }
async function insertIntent(client: PoolClient, f: Fixture, suffix: string, relationship: string, capability: string | null, mode: 'FIXED_SLOT' | 'QUEUE', queueWindow = f.queueWindow) {
  const id = randomUUID(); const queue = mode === 'QUEUE' ? queueWindow : null;
  await client.query(`INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,booking_tenant_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,capability_key,scheduling_mode,queue_window_id,state,idempotency_key,request_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'INR',10000,'Asia/Kolkata',current_timestamp::timestamp,current_timestamp+interval '2 days',current_timestamp+interval '2 days 30 minutes',1800,0,0,600,$10,$11,$12,$13,'APPOINTMENT_INTENT',$14,$15,current_timestamp+interval '10 minutes')`, [id, f.patient, relationship === 'CLINIC_DOCTOR' ? f.clinicAccountA : f.patient, relationship === 'CLINIC_DOCTOR' ? f.tenantA : null, f.doctor, f.exposure, f.offering, f.version, f.price, relationship, capability, mode, queue, `phase58-${suffix}-${id}`, `phase58-${suffix}`]);
  return id;
}

async function insertQueueEntry(client: PoolClient, f: Fixture, intent: string, position: number) { const id = randomUUID(); await client.query("INSERT INTO queue_entries (id,queue_window_id,appointment_intent_id,patient_account_id,booking_actor_account_id,maximum_capacity,queue_position) VALUES ($1,$2,$3,$4,$5,2,$6)", [id, f.queueWindow, intent, f.patient, f.patient, position]); return id; }
async function attachQueueEntry(client: PoolClient, intent: string, entry: string) { await client.query('UPDATE appointment_intents SET queue_entry_id=$2 WHERE id=$1', [intent, entry]); }
type ConcurrentQueueEntry = { entryId: string; intentId: string };

async function insertFinalCapacityQueueEntry(client: PoolClient, fixture: Fixture, suffix: string, position: number, maximumCapacity: number, readyToInsert: () => Promise<void>): Promise<ConcurrentQueueEntry> {
  try {
    await client.query('BEGIN');
    await readyToInsert();
    const intent = await insertQueueIntent(client, fixture, suffix);
    const entryId = randomUUID();
    await client.query('INSERT INTO queue_entries (id,queue_window_id,appointment_intent_id,patient_account_id,booking_actor_account_id,maximum_capacity,queue_position) VALUES ($1,$2,$3,$4,$5,$6,$7)', [entryId, fixture.queueWindow, intent, fixture.patient, fixture.patient, maximumCapacity, position]);
    await attachQueueEntry(client, intent, entryId);
    await client.query('COMMIT');
    return { entryId, intentId: intent };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function concurrentBarrier(expected: number) {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => { arrivals += 1; if (arrivals === expected) release?.(); await ready; };
}
async function insertDelegatedAuthorization(client: PoolClient, f: Fixture, status: 'ACTIVE') {
  const id = randomUUID(); await client.query(`INSERT INTO patient_clinic_booking_authorizations (id,patient_account_id,patient_profile_id,delegated_clinic_id,delegated_tenant_id,target_doctor_profile_id,service_exposure_id,service_offering_id,scheduling_mode,approved_starts_at,approved_ends_at,scope_fingerprint,policy_version_id,consented_by_account_id,consented_at,expires_at,status)
    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'FIXED_SLOT',current_timestamp+interval '2 days',current_timestamp+interval '2 days 30 minutes',$8,$9,$2,current_timestamp,current_timestamp+interval '5 minutes',$10)`, [id, f.patient, f.clinicA, f.tenantA, f.doctor, f.exposure, f.offering, `scope-${id}`, f.delegatedPolicy, status]); return id;
}

async function insertNonActiveDelegatedAuthorization(client: PoolClient, f: Fixture, status: 'CONSUMED' | 'REVOKED' | 'EXPIRED', consumingIntent?: string) {
  const id = randomUUID();
  await client.query(`INSERT INTO patient_clinic_booking_authorizations (id,patient_account_id,patient_profile_id,delegated_clinic_id,delegated_tenant_id,target_doctor_profile_id,service_exposure_id,service_offering_id,scheduling_mode,approved_starts_at,approved_ends_at,scope_fingerprint,policy_version_id,consented_by_account_id,consented_at,expires_at,status,consuming_appointment_intent_id,consumed_at,consumed_by_account_id,revoked_at,revoked_by_account_id,revocation_reason_category)
    VALUES ($1,$2::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,'FIXED_SLOT',current_timestamp+interval '2 days',current_timestamp+interval '2 days 30 minutes',$8,$9::uuid,$2::uuid,current_timestamp,current_timestamp+interval '5 minutes',$10::text,$11::uuid,CASE WHEN $10::text='CONSUMED' THEN current_timestamp END,CASE WHEN $10::text='CONSUMED' THEN $3::uuid END,CASE WHEN $10::text='REVOKED' THEN current_timestamp END,CASE WHEN $10::text='REVOKED' THEN $2::uuid END,CASE WHEN $10::text='REVOKED' THEN 'PATIENT'::text END)`, [id, f.patient, f.clinicA, f.tenantA, f.doctor, f.exposure, f.offering, `non-active-${id}`, f.delegatedPolicy, status, consumingIntent ?? null]);
  return id;
}

async function insertExpiredActiveDelegatedAuthorization(client: PoolClient, f: Fixture) {
  const id = randomUUID();
  await client.query(`INSERT INTO patient_clinic_booking_authorizations (id,patient_account_id,patient_profile_id,delegated_clinic_id,delegated_tenant_id,target_doctor_profile_id,service_exposure_id,service_offering_id,scheduling_mode,approved_starts_at,approved_ends_at,scope_fingerprint,policy_version_id,consented_by_account_id,consented_at,expires_at,status,created_at)
    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'FIXED_SLOT',current_timestamp+interval '2 days',current_timestamp+interval '2 days 30 minutes',$8,$9,$2,current_timestamp,current_timestamp-interval '1 second','ACTIVE',current_timestamp-interval '301 seconds')`, [id, f.patient, f.clinicA, f.tenantA, f.doctor, f.exposure, f.offering, `expired-${id}`, f.delegatedPolicy]);
  return id;
}

async function insertDelegatedQueueAuthorization(client: PoolClient, f: Fixture, queueWindow: string) {
  const id = randomUUID();
  await client.query(`INSERT INTO patient_clinic_booking_authorizations (id,patient_account_id,patient_profile_id,delegated_clinic_id,delegated_tenant_id,target_doctor_profile_id,service_exposure_id,service_offering_id,scheduling_mode,queue_window_id,scope_fingerprint,policy_version_id,consented_by_account_id,consented_at,expires_at,status)
    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'QUEUE',$8,$9,$10,$2,current_timestamp,current_timestamp+interval '5 minutes','ACTIVE')`, [id, f.patient, f.clinicA, f.tenantA, f.doctor, f.exposure, f.offering, queueWindow, `queue-scope-${id}`, f.delegatedPolicy]);
  return id;
}

async function insertUnrelatedQueueWindow(client: PoolClient, f: Fixture) {
  const offering = randomUUID(); const version = randomUUID(); const configuration = randomUUID(); const policy = randomUUID(); const window = randomUUID();
  await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Unrelated queue scope','ACTIVE',$3,$3)", [offering, f.doctor, f.doctorAccount]);
  await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',current_timestamp-interval '1 day',$3)", [version, offering, f.doctorAccount]);
  await client.query("INSERT INTO availability_configurations (id,service_offering_version_id,provider_timezone,slot_duration_seconds,buffer_before_seconds,buffer_after_seconds,capacity,booking_lead_time_seconds,booking_horizon_seconds,status,created_by_account_id) VALUES ($1,$2,'Asia/Kolkata',1800,0,0,2,0,1209600,'ACTIVE',$3)", [configuration, version, f.doctorAccount]);
  await client.query('INSERT INTO service_offering_version_queue_policies (id,service_offering_version_id,maximum_capacity,booking_cutoff_seconds,created_by_account_id) VALUES ($1,$2,2,0,$3)', [policy, version, f.doctorAccount]);
  await client.query(`INSERT INTO queue_windows (id,service_offering_version_id,availability_configuration_id,queue_policy_id,local_start,local_end,derived_start_utc,derived_end_utc,maximum_capacity,booking_cutoff_at,status,created_by_account_id)
    SELECT $1,$2,$3,$4,local_start,local_end,availability_derive_utc('Asia/Kolkata',local_start),availability_derive_utc('Asia/Kolkata',local_end),2,availability_derive_utc('Asia/Kolkata',local_start),'OPEN',$5
    FROM (SELECT date_trunc('day',current_timestamp AT TIME ZONE 'Asia/Kolkata') + interval '3 days 9 hours' AS local_start,date_trunc('day',current_timestamp AT TIME ZONE 'Asia/Kolkata') + interval '3 days 10 hours' AS local_end) value`, [window, version, configuration, policy, f.doctorAccount]);
  return window;
}

async function seedNetwork(client: PoolClient, f: Fixture) {
  const [left, right] = [f.clinicA, f.clinicB].sort();
  await client.query("INSERT INTO network_connections (id,connection_kind,clinic_left_id,doctor_profile_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id,accepted_at) VALUES ($1,'CLINIC_DOCTOR',$2,$3,'ACCEPTED',$4,'DOCTOR','CLINIC',$2,current_timestamp)", [f.clinicDoctorConnection, f.clinicA, f.doctor, f.clinicAccountA]);
  await client.query("INSERT INTO network_connections (id,connection_kind,clinic_left_id,clinic_right_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id,accepted_at) VALUES ($1,'CLINIC_CLINIC',$2,$3,'ACCEPTED',$4,'CLINIC','CLINIC',$5,current_timestamp)", [f.clinicClinicConnection, left, right, f.clinicAccountA, f.clinicA]);
  f.bookProposal = await acceptedProposal(client, f.clinicDoctorConnection, 'BOOK', 'DOCTOR', f.doctor, 'CLINIC', f.clinicA, f.doctorAccount, f.clinicAccountA);
  f.referProposal = await acceptedProposal(client, f.clinicClinicConnection, 'REFER', 'CLINIC', f.clinicB, 'CLINIC', f.clinicA, f.clinicAccountB, f.clinicAccountA);
  f.bookCapability = await insertCapability(client, f.clinicDoctorConnection, 'BOOK', f.bookProposal, 'DOCTOR', f.doctor, 'CLINIC', f.clinicA, f.clinicAccountA);
  f.referCapability = await insertCapability(client, f.clinicClinicConnection, 'REFER', f.referProposal, 'CLINIC', f.clinicB, 'CLINIC', f.clinicA, f.clinicAccountA);
}

type NetworkEvidence = { connection: string; capability: string; proposal: string };

async function insertAlternateBookCapability(client: PoolClient, f: Fixture): Promise<NetworkEvidence> {
  const account = randomUUID(); const doctor = randomUUID(); const connection = randomUUID();
  await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE')", [account]);
  await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, account]);
  await client.query("INSERT INTO network_connections (id,connection_kind,clinic_left_id,doctor_profile_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id,accepted_at) VALUES ($1,'CLINIC_DOCTOR',$2,$3,'ACCEPTED',$4,'DOCTOR','CLINIC',$2,current_timestamp)", [connection, f.clinicA, doctor, f.clinicAccountA]);
  const proposal = await acceptedProposal(client, connection, 'BOOK', 'DOCTOR', doctor, 'CLINIC', f.clinicA, account, f.clinicAccountA);
  const capability = await insertCapability(client, connection, 'BOOK', proposal, 'DOCTOR', doctor, 'CLINIC', f.clinicA, f.clinicAccountA);
  return { connection, capability, proposal };
}

async function insertReverseReferCapability(client: PoolClient, f: Fixture): Promise<NetworkEvidence> {
  const proposal = await acceptedProposal(client, f.clinicClinicConnection, 'REFER', 'CLINIC', f.clinicA, 'CLINIC', f.clinicB, f.clinicAccountA, f.clinicAccountB);
  const capability = await insertCapability(client, f.clinicClinicConnection, 'REFER', proposal, 'CLINIC', f.clinicA, 'CLINIC', f.clinicB, f.clinicAccountB);
  return { connection: f.clinicClinicConnection, capability, proposal };
}
async function acceptedProposal(client: PoolClient, connection: string, key: string, proposerKind: string, proposer: string, accepterKind: string, accepter: string, actor: string, accepterActor: string) {
  const id = randomUUID(); await client.query("INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,proposer_doctor_profile_id,accepter_party_kind,accepter_clinic_id,accepter_doctor_profile_id,proposed_by_account_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')", [id, connection, key, proposerKind, proposerKind === 'CLINIC' ? proposer : null, proposerKind === 'DOCTOR' ? proposer : null, accepterKind, accepterKind === 'CLINIC' ? accepter : null, accepterKind === 'DOCTOR' ? accepter : null, actor]);
  await client.query("UPDATE network_capability_proposals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [id, accepterActor]); return id;
}
async function insertCapability(client: PoolClient, connection: string, key: string, proposal: string, grantorKind: string, grantor: string, granteeKind: string, grantee: string, actor: string) {
  const id = randomUUID(); await client.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_clinic_id,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id,grantee_doctor_profile_id) VALUES ($1,$2,$3,'ACTIVE',current_timestamp,$4,$5,$6,$7,$8,$9,$10,$11)", [id, connection, key, actor, proposal, grantorKind, grantorKind === 'CLINIC' ? grantor : null, grantorKind === 'DOCTOR' ? grantor : null, granteeKind, granteeKind === 'CLINIC' ? grantee : null, granteeKind === 'DOCTOR' ? grantee : null]); return id;
}
async function insertReferral(client: PoolClient, f: Fixture, purpose: string) {
  const id = randomUUID(); await client.query(`INSERT INTO appointment_referrals (id,patient_account_id,patient_profile_id,referring_clinic_id,referring_tenant_id,receiving_clinic_id,receiving_tenant_id,network_connection_id,network_capability_id,accepted_proposal_id,destination_service_exposure_id,destination_service_offering_id,purpose_context_fingerprint,policy_version_id,retention_policy_version_id,created_by_account_id,expires_at,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,current_timestamp+interval '5 minutes','PENDING_PATIENT_CONSENT')`, [id, f.patient, f.patientProfile, f.clinicA, f.tenantA, f.clinicB, f.tenantB, f.clinicClinicConnection, f.referCapability, f.referProposal, f.clinicExposure, f.clinicOffering, purpose, f.referralPolicy, f.retentionPolicy, f.clinicAccountA]); return id;
}
async function insertNetworkContext(client: PoolClient, f: Fixture, intent: string, authorization: string, actor: string, evidence: NetworkEvidence = { connection: f.clinicDoctorConnection, capability: f.bookCapability, proposal: f.bookProposal }) {
  const id = randomUUID(); await client.query(`INSERT INTO network_booking_contexts (id,appointment_intent_id,booking_kind,patient_account_id,booking_actor_account_id,originating_tenant_id,network_connection_id,network_capability_id,accepted_proposal_id,patient_clinic_booking_authorization_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,scheduling_mode)
    VALUES ($1,$2,'CLINIC_DOCTOR_DELEGATED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'FIXED_SLOT')`, [id, intent, f.patient, actor, f.tenantA, evidence.connection, evidence.capability, evidence.proposal, authorization, f.exposure, f.offering, f.version, f.price]); return id;
}
async function insertQueueNetworkContextWithoutEntry(client: PoolClient, f: Fixture, intent: string, authorization: string) {
  const id = randomUUID(); await client.query(`INSERT INTO network_booking_contexts (id,appointment_intent_id,booking_kind,patient_account_id,booking_actor_account_id,originating_tenant_id,network_connection_id,network_capability_id,accepted_proposal_id,patient_clinic_booking_authorization_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,scheduling_mode,queue_window_id)
    VALUES ($1,$2,'CLINIC_DOCTOR_DELEGATED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'QUEUE',$14)`, [id, intent, f.patient, f.clinicAccountA, f.tenantA, f.clinicDoctorConnection, f.bookCapability, f.bookProposal, authorization, f.exposure, f.offering, f.version, f.price, f.queueWindow]); return id;
}

async function insertClinicReferralIntent(client: PoolClient, f: Fixture, suffix: string) {
  const id = randomUUID();
  await client.query(`INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,booking_tenant_id,provider_clinic_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,capability_key,state,idempotency_key,request_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'INR',10000,'Asia/Kolkata',current_timestamp::timestamp,current_timestamp+interval '2 days',current_timestamp+interval '2 days 30 minutes',1800,0,0,600,'CLINIC_CLINIC','REFER','APPOINTMENT_INTENT',$10,$11,current_timestamp+interval '10 minutes')`, [id, f.patient, f.clinicAccountB, f.tenantB, f.clinicB, f.clinicExposure, f.clinicOffering, f.clinicVersion, f.clinicPrice, `phase58-${suffix}-${id}`, `phase58-${suffix}`]);
  return id;
}

async function insertReferralNetworkContext(client: PoolClient, f: Fixture, intent: string, referral: string, evidence: NetworkEvidence) {
  const id = randomUUID();
  await client.query(`INSERT INTO network_booking_contexts (id,appointment_intent_id,booking_kind,patient_account_id,booking_actor_account_id,originating_tenant_id,network_connection_id,network_capability_id,accepted_proposal_id,appointment_referral_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,scheduling_mode)
    VALUES ($1,$2,'CLINIC_CLINIC_REFERRAL',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'FIXED_SLOT')`, [id, intent, f.patient, f.clinicAccountB, f.tenantB, evidence.connection, evidence.capability, evidence.proposal, referral, f.clinicExposure, f.clinicOffering, f.clinicVersion, f.clinicPrice]);
  return id;
}

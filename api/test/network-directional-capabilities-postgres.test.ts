import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PostgresNetworkRepository } from '../src/modules/network/postgres-network-repository.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
const [clinicAccountA, clinicAccountB, doctorAccount, tenantA, tenantB, clinicA, clinicB, doctor, clinicDoctorConnection, clinicClinicConnection] = Array.from({ length: 10 }, randomUUID);
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!enabled)('Phase 5.8 directional network capabilities on PostgreSQL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_network_capabilities_verify') throw new Error('Refusing PostgreSQL integration tests outside cliniq_phase5_network_capabilities_verify.');
    const schema = await pool.query("SELECT to_regclass('network_capability_proposals') AS proposals, to_regclass('network_connection_capabilities') AS capabilities");
    if (!schema.rows[0]?.proposals || !schema.rows[0]?.capabilities) throw new Error('Phase 5.8 network capability migration is not applied.');
    await seed(pool); databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });
  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); if (pool) await cleanup(pool); await pool?.end(); });

  it('rejects direct SQL proposal/capability spoofing and permits opposite REFER directions', async () => {
    const book = await acceptedProposal(pool!, clinicDoctorConnection, 'BOOK', 'DOCTOR', doctor, 'CLINIC', clinicA, doctorAccount, clinicAccountA);
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'DOCTOR',$5,'CLINIC',$6)", [randomUUID(), clinicDoctorConnection, clinicAccountA, book, doctor, clinicA])).resolves.toBeDefined();
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'DOCTOR',$5,'CLINIC',$6)", [randomUUID(), clinicDoctorConnection, clinicAccountA, book, doctor, clinicA])).rejects.toThrow();
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_clinic_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'CLINIC',$5,'CLINIC',$6)", [randomUUID(), clinicDoctorConnection, clinicAccountA, book, clinicA, clinicA])).rejects.toThrow();
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'DOCTOR',$5,'CLINIC',$6)", [randomUUID(), clinicDoctorConnection, clinicAccountA, book, doctor, clinicB])).rejects.toThrow();
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'DOCTOR',$5,'CLINIC',$6)", [randomUUID(), clinicClinicConnection, clinicAccountA, book, doctor, clinicA])).rejects.toThrow();
    const pending = await pendingProposal(pool!, clinicDoctorConnection, 'BOOK', 'DOCTOR', doctor, 'CLINIC', clinicA, doctorAccount);
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_doctor_profile_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'BOOK','ACTIVE',current_timestamp,$3,$4,'DOCTOR',$5,'CLINIC',$6)", [randomUUID(), clinicDoctorConnection, clinicAccountA, pending, doctor, clinicA])).rejects.toThrow();
    await pool!.query("UPDATE network_capability_proposals SET status='REVOKED',revoked_at=current_timestamp,revoked_by_account_id=$2 WHERE id=$1", [pending, doctorAccount]);
    const referA = await acceptedProposal(pool!, clinicClinicConnection, 'REFER', 'CLINIC', clinicA, 'CLINIC', clinicB, clinicAccountA, clinicAccountB);
    const referB = await acceptedProposal(pool!, clinicClinicConnection, 'REFER', 'CLINIC', clinicB, 'CLINIC', clinicA, clinicAccountB, clinicAccountA);
    for (const [proposal, grantor, grantee, actor] of [[referA, clinicA, clinicB, clinicAccountB], [referB, clinicB, clinicA, clinicAccountA]]) await pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_clinic_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'REFER','ACTIVE',current_timestamp,$3,$4,'CLINIC',$5,'CLINIC',$6)", [randomUUID(), clinicClinicConnection, actor, proposal, grantor, grantee]);
    const activeRefer = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM network_connection_capabilities WHERE network_connection_id=$1 AND capability_key='REFER' AND status='ACTIVE'", [clinicClinicConnection]);
    expect(activeRefer.rows[0]?.count).toBe('2');
    const duplicateRefer = await acceptedProposal(pool!, clinicClinicConnection, 'REFER', 'CLINIC', clinicA, 'CLINIC', clinicB, clinicAccountA, clinicAccountB);
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id,grantor_party_kind,grantor_clinic_id,grantee_party_kind,grantee_clinic_id) VALUES ($1,$2,'REFER','ACTIVE',current_timestamp,$3,$4,'CLINIC',$5,'CLINIC',$6)", [randomUUID(), clinicClinicConnection, clinicAccountB, duplicateRefer, clinicA, clinicB])).rejects.toThrow();
    const discover = await acceptedProposal(pool!, clinicDoctorConnection, 'DISCOVER', 'CLINIC', clinicA, 'DOCTOR', doctor, clinicAccountA, doctorAccount);
    await pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id) VALUES ($1,$2,'DISCOVER','ACTIVE',current_timestamp,$3,$4)", [randomUUID(), clinicDoctorConnection, doctorAccount, discover]);
    const duplicateDiscover = await acceptedProposal(pool!, clinicDoctorConnection, 'DISCOVER', 'DOCTOR', doctor, 'CLINIC', clinicA, doctorAccount, clinicAccountA);
    await expect(pool!.query("INSERT INTO network_connection_capabilities (id,network_connection_id,capability_key,status,granted_at,granted_by_account_id,accepted_proposal_id) VALUES ($1,$2,'DISCOVER','ACTIVE',current_timestamp,$3,$4)", [randomUUID(), clinicDoctorConnection, clinicAccountA, duplicateDiscover])).rejects.toThrow();
    await pool!.query("UPDATE network_connection_capabilities SET status='REVOKED' WHERE accepted_proposal_id=$1", [book]);
    await expect(pool!.query("UPDATE network_connection_capabilities SET status='ACTIVE' WHERE accepted_proposal_id=$1", [book])).rejects.toThrow();
  });

  it('serializes concurrent acceptance of one directional proposal into one active grant', async () => {
    const proposalId = await pendingProposal(pool!, clinicDoctorConnection, 'BOOK', 'DOCTOR', doctor, 'CLINIC', clinicA, doctorAccount);
    const first = databaseA!.transaction(async (db) => { const repository = new PostgresNetworkRepository(databaseA!); const proposal = await repository.lockProposal(db, proposalId); return proposal && repository.acceptProposal(db, proposal, clinicAccountA); });
    const second = databaseB!.transaction(async (db) => { const repository = new PostgresNetworkRepository(databaseB!); const proposal = await repository.lockProposal(db, proposalId); return proposal && repository.acceptProposal(db, proposal, clinicAccountA); });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
    const persisted = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM network_connection_capabilities WHERE accepted_proposal_id=$1 AND status='ACTIVE'", [proposalId]);
    expect(persisted.rows[0]?.count).toBe('1');
  });

  it('serializes directional revocation and a competing regrant without duplicate active capability state', async () => {
    const active = await pool!.query<{ accepted_proposal_id: string }>("SELECT accepted_proposal_id FROM network_connection_capabilities WHERE network_connection_id=$1 AND capability_key='BOOK' AND status='ACTIVE'", [clinicDoctorConnection]);
    const replacement = await pendingProposal(pool!, clinicDoctorConnection, 'BOOK', 'DOCTOR', doctor, 'CLINIC', clinicA, doctorAccount);
    const revoke = databaseA!.transaction(async (db) => { const repository = new PostgresNetworkRepository(databaseA!); await repository.lockConnection(db, clinicDoctorConnection); return repository.revokeCapability(db, clinicDoctorConnection, 'BOOK', doctorAccount, active.rows[0]!.accepted_proposal_id); });
    const accept = databaseB!.transaction(async (db) => { const repository = new PostgresNetworkRepository(databaseB!); await repository.lockConnection(db, clinicDoctorConnection); const proposal = await repository.lockProposal(db, replacement); return proposal && repository.acceptProposal(db, proposal, clinicAccountA); });
    const results = await Promise.allSettled([revoke, accept]);
    expect(results.some((result) => result.status === 'fulfilled' && result.value === true)).toBe(true);
    const activeCount = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM network_connection_capabilities WHERE network_connection_id=$1 AND capability_key='BOOK' AND status='ACTIVE'", [clinicDoctorConnection]);
    expect(Number(activeCount.rows[0]?.count)).toBeLessThanOrEqual(1);
  });
});

async function seed(target: Pool) {
  await target.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE'),($3,'ACTIVE')", [clinicAccountA, clinicAccountB, doctorAccount]);
  await target.query("INSERT INTO tenants (id,status,created_by_account_id) VALUES ($1,'ACTIVE',$3),($2,'ACTIVE',$3)", [tenantA, tenantB, clinicAccountA]);
  await target.query("INSERT INTO clinics (id,tenant_id,status,legal_name,display_name,created_by_account_id) VALUES ($1,$2,'ACTIVE','A Legal','A',$3),($4,$5,'ACTIVE','B Legal','B',$6)", [clinicA, tenantA, clinicAccountA, clinicB, tenantB, clinicAccountB]);
  await target.query("INSERT INTO tenant_memberships (id,tenant_id,account_id,role_key,status) VALUES ($1,$2,$3,'CLINIC_OWNER','ACTIVE'),($4,$5,$6,'CLINIC_OWNER','ACTIVE')", [randomUUID(), tenantA, clinicAccountA, randomUUID(), tenantB, clinicAccountB]);
  await target.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await target.query("INSERT INTO network_connections (id,connection_kind,clinic_left_id,doctor_profile_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id,accepted_at) VALUES ($1,'CLINIC_DOCTOR',$2,$3,'ACCEPTED',$4,'DOCTOR','CLINIC',$2,current_timestamp)", [clinicDoctorConnection, clinicA, doctor, clinicAccountA]);
  const [clinicLeft, clinicRight] = [clinicA, clinicB].sort();
  await target.query("INSERT INTO network_connections (id,connection_kind,clinic_left_id,clinic_right_id,status,initiated_by_account_id,recipient_party_kind,initiator_party_kind,initiator_clinic_id,accepted_at) VALUES ($1,'CLINIC_CLINIC',$2,$3,'ACCEPTED',$4,'CLINIC','CLINIC',$5,current_timestamp)", [clinicClinicConnection, clinicLeft, clinicRight, clinicAccountA, clinicA]);
}
async function pendingProposal(target: Pool, connection: string, capability: string, proposerKind: string, proposer: string, accepterKind: string, accepter: string, actor: string) { const id = randomUUID(); await target.query('INSERT INTO network_capability_proposals (id,network_connection_id,capability_key,proposer_party_kind,proposer_clinic_id,proposer_doctor_profile_id,accepter_party_kind,accepter_clinic_id,accepter_doctor_profile_id,proposed_by_account_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'PENDING\')', [id, connection, capability, proposerKind, proposerKind === 'CLINIC' ? proposer : null, proposerKind === 'DOCTOR' ? proposer : null, accepterKind, accepterKind === 'CLINIC' ? accepter : null, accepterKind === 'DOCTOR' ? accepter : null, actor]); return id; }
async function acceptedProposal(target: Pool, connection: string, capability: string, proposerKind: string, proposer: string, accepterKind: string, accepter: string, actor: string, accepterAccount: string) { const id = await pendingProposal(target, connection, capability, proposerKind, proposer, accepterKind, accepter, actor); await target.query("UPDATE network_capability_proposals SET status='ACCEPTED',accepted_at=current_timestamp,accepted_by_account_id=$2 WHERE id=$1", [id, accepterAccount]); return id; }
async function cleanup(target: Pool) { await target.query('DELETE FROM network_connection_capabilities WHERE network_connection_id IN ($1,$2)', [clinicDoctorConnection, clinicClinicConnection]); await target.query('DELETE FROM network_capability_proposals WHERE network_connection_id IN ($1,$2)', [clinicDoctorConnection, clinicClinicConnection]); await target.query('DELETE FROM network_connections WHERE id IN ($1,$2)', [clinicDoctorConnection, clinicClinicConnection]); await target.query('DELETE FROM tenant_memberships WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]); await target.query('DELETE FROM clinics WHERE id IN ($1,$2)', [clinicA, clinicB]); await target.query('DELETE FROM doctor_profiles WHERE id=$1', [doctor]); await target.query('DELETE FROM tenants WHERE id IN ($1,$2)', [tenantA, tenantB]); await target.query('DELETE FROM accounts WHERE id IN ($1,$2,$3)', [clinicAccountA, clinicAccountB, doctorAccount]); }

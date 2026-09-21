import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
let pool: Pool | undefined;

describe.skipIf(!databaseUrl)('Phase 7.1C PostgreSQL file metadata schema guards', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== 'cliniq_phase71c_files_verify') throw new Error('Refusing Phase 7.1C integration tests outside cliniq_phase71c_files_verify.');
    const schema = await pool.query("SELECT to_regclass('files') AS files,to_regclass('file_bindings') AS bindings");
    if (!schema.rows[0]?.files || !schema.rows[0]?.bindings) throw new Error('Phase 7.1C files migration is not applied.');
  });

  afterAll(async () => { await pool?.end(); });

  it('creates file metadata with one FK-backed immutable binding and useful indexes', async () => withFixture(async (client, fixture) => {
    const file = await createFile(client, fixture);
    const fileBinding = await binding(client, file.id, fixture.patientProfile);
    await client.query('SET CONSTRAINTS files_require_one_binding IMMEDIATE');
    expect(fileBinding.purpose).toBe('PATIENT_PROFILE_MEDIA');
    const indexes = await client.query<{ names: string[] }>("SELECT array_agg(indexrelid::regclass::text ORDER BY indexrelid::regclass::text) AS names FROM pg_index WHERE indrelid IN ('files'::regclass,'file_bindings'::regclass)");
    expect(indexes.rows[0]?.names).toContain('files_status_created_at');
    expect(indexes.rows[0]?.names).toContain('file_bindings_patient_profile');
  }));

  it('enforces unique object keys and actor-scoped create idempotency', async () => withFixture(async (client, fixture) => {
    const first = await createFile(client, fixture, { objectKey: `objects/${randomUUID()}`, idempotencyKey: 'same-key' }); await binding(client, first.id, fixture.patientProfile);
    await expectPostgresError(client, () => createFile(client, fixture, { objectKey: first.objectKey, idempotencyKey: 'different-key' }), '23505');
    await expectPostgresError(client, () => createFile(client, fixture, { objectKey: `objects/${randomUUID()}`, idempotencyKey: 'same-key' }), '23505');
    const second = await createFile(client, { ...fixture, creator: fixture.otherAccount }, { objectKey: `objects/${randomUUID()}`, idempotencyKey: 'same-key' }); await binding(client, second.id, fixture.patientProfile);
  }));

  it('enforces positive size, safe metadata, available hashes, and pending creation', async () => withFixture(async (client, fixture) => {
    await expectPostgresError(client, () => createFile(client, fixture, { byteSize: 0 }), '23514');
    await expectPostgresError(client, () => createFile(client, fixture, { originalFilename: 'unsafe\nname.txt' }), '23514');
    await expectPostgresError(client, () => createFile(client, fixture, { status: 'AVAILABLE', sha256: 'a'.repeat(64) }), 'P0001');
    const file = await createFile(client, fixture); await binding(client, file.id, fixture.patientProfile);
    await expectPostgresError(client, () => client.query("UPDATE files SET status='AVAILABLE',sha256='not-a-hash' WHERE id=$1", [file.id]), '23514');
  }));

  it('allows only valid lifecycle transitions and preserves immutable storage identity', async () => withFixture(async (client, fixture) => {
    const file = await createFile(client, fixture); await binding(client, file.id, fixture.patientProfile);
    await client.query("UPDATE files SET status='UPLOAD_FAILED' WHERE id=$1", [file.id]);
    await client.query("UPDATE files SET status='PENDING_UPLOAD' WHERE id=$1", [file.id]);
    await client.query("UPDATE files SET status='AVAILABLE',sha256=$2 WHERE id=$1", [file.id, 'a'.repeat(64)]);
    await expectPostgresError(client, () => client.query("UPDATE files SET status='UPLOAD_FAILED' WHERE id=$1", [file.id]), 'P0001');
    await expectPostgresError(client, () => client.query("UPDATE files SET object_key='changed' WHERE id=$1", [file.id]), 'P0001');
    await client.query("UPDATE files SET status='DELETE_PENDING' WHERE id=$1", [file.id]);
    await client.query("UPDATE files SET status='DELETED',deleted_by_account_id=$2 WHERE id=$1", [file.id, fixture.creator]);
    await expectPostgresError(client, () => client.query('DELETE FROM files WHERE id=$1', [file.id]), 'P0001');
  }));

  it('enforces one immutable approved binding with FK integrity', async () => withFixture(async (client, fixture) => {
    const file = await createFile(client, fixture);
    await binding(client, file.id, fixture.patientProfile);
    await expectPostgresError(client, () => binding(client, file.id, fixture.patientProfile), '23505');
    const invalidTarget = await createFile(client, fixture);
    await expectPostgresError(client, () => binding(client, invalidTarget.id, randomUUID()), '23503');
    const unsupported = await createFile(client, fixture);
    await expectPostgresError(client, () => client.query("INSERT INTO file_bindings (id,file_id,purpose) VALUES ($1,$2,'CAREER_RESUME')", [randomUUID(), unsupported.id]), '23514');
    await expectPostgresError(client, () => client.query('UPDATE file_bindings SET purpose=$2 WHERE file_id=$1', [file.id, 'DOCTOR_PROFILE_MEDIA']), 'P0001');
  }));
});

type Fixture = { creator: string; otherAccount: string; patientProfile: string };
type FileInput = { id: string; objectKey: string; idempotencyKey: string; byteSize: number; originalFilename: string; status: string; sha256: string | null };

async function withFixture(operation: (client: PoolClient, fixture: Fixture) => Promise<void>): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const fixture = { creator: randomUUID(), otherAccount: randomUUID(), patientProfile: randomUUID() };
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [fixture.creator, fixture.otherAccount]);
    await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$2,'ACTIVE')", [fixture.patientProfile, fixture.creator]);
    await operation(client, fixture);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function createFile(client: PoolClient, fixture: Pick<Fixture, 'creator'>, input: Partial<FileInput> = {}): Promise<FileInput> {
  const file: FileInput = { id: input.id ?? randomUUID(), objectKey: input.objectKey ?? `objects/${randomUUID()}`, idempotencyKey: input.idempotencyKey ?? randomUUID(), byteSize: input.byteSize ?? 32, originalFilename: input.originalFilename ?? 'probe.txt', status: input.status ?? 'PENDING_UPLOAD', sha256: input.sha256 ?? null };
  await client.query('INSERT INTO files (id,storage_provider,bucket,object_key,original_filename,content_type,byte_size,sha256,status,created_by_account_id,create_idempotency_key,create_request_fingerprint) VALUES ($1,\'AIC_S3\',\'test-bucket\',$2,$3,\'text/plain\',$4,$5,$6,$7,$8,\'fixture\')', [file.id, file.objectKey, file.originalFilename, file.byteSize, file.sha256, file.status, fixture.creator, file.idempotencyKey]);
  return file;
}

async function binding(client: PoolClient, fileId: string, patientProfileId: string): Promise<{ purpose: string }> {
  const result = await client.query<{ purpose: string }>("INSERT INTO file_bindings (id,file_id,purpose,patient_profile_id) VALUES ($1,$2,'PATIENT_PROFILE_MEDIA',$3) RETURNING purpose", [randomUUID(), fileId, patientProfileId]);
  return result.rows[0]!;
}

async function expectPostgresError(
  client: PoolClient,
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await client.query('SAVEPOINT expected_postgres_error');
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_postgres_error');
    await client.query('RELEASE SAVEPOINT expected_postgres_error');
  }
  expect(error).toMatchObject({ code });
}

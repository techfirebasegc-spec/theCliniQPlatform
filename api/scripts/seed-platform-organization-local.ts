import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/infrastructure/database.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const environmentFile = resolve(scriptDirectory, '..', '.env');
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('LOCAL_ORGANIZATION_DATABASE_URL_REQUIRED');
const target = new URL(databaseUrl);
if (target.hostname !== '127.0.0.1' || target.port !== '5433' || target.pathname !== '/cliniq_platform') throw new Error('LOCAL_ORGANIZATION_REFUSES_NON_LOCAL_DATABASE');

const platformAdmin = '0127c268-6fae-4ee8-a764-85ae11f912ea';
const clinics = [
  { tenantId: 'ef598c6b-e61b-4bdf-bef2-867f2443860f', clinicId: '58db583a-af03-484e-9daa-78b13f1e114d', ownerAccountId: 'b5d9d714-42ab-4c10-b43d-4799d8a46c51', ownerMembershipId: 'b65ad5d0-4ce0-4a64-9a65-3bb2d1d63545', ownerName: 'Local Clinic A Owner' },
  { tenantId: '30d3c4e0-5fbb-4e04-86da-ddbd23d38d1d', clinicId: '3a2d59f4-bbdf-4b58-bf16-5e09d3b3aed1', ownerAccountId: '01765d0a-f38b-4d40-bd17-16140f2b404f', ownerMembershipId: '2ee4db51-7f01-48da-b3f3-6ae9cd4c9728', ownerName: 'Local Clinic B Owner' },
] as const;

async function main(): Promise<void> {
  const database = createDatabase({ DATABASE_URL: databaseUrl });
  try {
    const result = await database.transaction(async (transaction) => {
      const entitlement = await transaction.query<{ id: string }>("SELECT id FROM platform_admin_entitlements WHERE account_id=$1 AND status='ACTIVE' FOR SHARE", [platformAdmin]);
      if (!entitlement.rows[0]) throw new Error('LOCAL_ORGANIZATION_PLATFORM_ADMIN_ENTITLEMENT_REQUIRED');

      for (const clinic of clinics) {
        const present = await transaction.query<{ id: string }>("SELECT clinic.id FROM clinics clinic JOIN tenants tenant ON tenant.id=clinic.tenant_id WHERE clinic.id=$1 AND clinic.tenant_id=$2 AND clinic.status='ACTIVE' AND tenant.status='ACTIVE' FOR UPDATE OF clinic, tenant", [clinic.clinicId, clinic.tenantId]);
        if (!present.rows[0]) throw new Error('LOCAL_ORGANIZATION_ACTIVE_CLINIC_REQUIRED');
        await transaction.query("INSERT INTO accounts (id,status,display_name,created_by_account_id,updated_by_account_id) VALUES ($1,'ACTIVE',$2,$3,$3) ON CONFLICT (id) DO NOTHING", [clinic.ownerAccountId, clinic.ownerName, platformAdmin]);
        await transaction.query("INSERT INTO tenant_memberships (id,tenant_id,account_id,role_key,status,invited_by_account_id,invited_at,accepted_at) VALUES ($1,$2,$3,'CLINIC_OWNER','ACTIVE',$4,current_timestamp,current_timestamp) ON CONFLICT (id) DO NOTHING", [clinic.ownerMembershipId, clinic.tenantId, clinic.ownerAccountId, platformAdmin]);
        await transaction.query("UPDATE tenant_memberships SET status='REMOVED', removed_at=current_timestamp, removed_by_account_id=$3, removal_reason='PLATFORM_ADMIN_SEPARATION', updated_at=current_timestamp WHERE tenant_id=$1 AND account_id=$2 AND status='ACTIVE'", [clinic.tenantId, platformAdmin, platformAdmin]);
      }

      const verified = await transaction.query<{ clinic_id: string; owner_account_id: string; platform_admin_memberships: string }>(`
        SELECT clinic.id AS clinic_id, owner.account_id AS owner_account_id,
          (SELECT count(*)::text FROM tenant_memberships admin WHERE admin.tenant_id=clinic.tenant_id AND admin.account_id=$1 AND admin.status='ACTIVE') AS platform_admin_memberships
        FROM clinics clinic
        JOIN tenant_memberships owner ON owner.tenant_id=clinic.tenant_id AND owner.role_key='CLINIC_OWNER' AND owner.status='ACTIVE'
        WHERE clinic.id = ANY($2::uuid[])
        ORDER BY clinic.id
      `, [platformAdmin, clinics.map((clinic) => clinic.clinicId)]);
      if (verified.rows.length !== clinics.length || verified.rows.some((row) => row.owner_account_id === platformAdmin || row.platform_admin_memberships !== '0')) throw new Error('LOCAL_ORGANIZATION_VERIFICATION_FAILED');
      return verified.rows;
    });
    console.log(JSON.stringify({ status: 'ok', clinics: result }, null, 2));
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'LOCAL_ORGANIZATION_FAILED');
  process.exitCode = 1;
});

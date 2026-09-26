import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/infrastructure/database.js';
import { AdminProvisioner, requireAdminProvisioningTarget, requireFirebaseUid } from '../src/modules/admin-access/admin-provisioning.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const environmentFile = resolve(repositoryRoot, '.env');

if (existsSync(environmentFile)) loadEnvFile(environmentFile);

async function main(): Promise<void> {
  const suppliedArguments = process.argv.slice(2);
  if (suppliedArguments.length !== 1) throw new Error('ADMIN_PROVISIONING_INVALID_FIREBASE_UID');

  const firebaseUid = requireFirebaseUid(suppliedArguments[0]);
  const target = requireAdminProvisioningTarget({ nodeEnvironment: process.env.NODE_ENV, target: process.env.ADMIN_PROVISIONING_TARGET });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('ADMIN_PROVISIONING_DATABASE_URL_REQUIRED');

  const database = createDatabase({ DATABASE_URL: databaseUrl });
  try {
    const provisioned = await new AdminProvisioner(database).provision(firebaseUid, target);
    console.log(`Status: SUCCESS\nFirebase UID: ${provisioned.firebaseUid}\nPlatform account ID: ${provisioned.accountId}\nAdmin entitlement ID: ${provisioned.entitlementId}\nTarget: ${provisioned.target}`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'ADMIN_PROVISIONING_FAILED';
  console.error(`Admin provisioning failed: ${code}`);
  process.exitCode = 1;
});

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const command = process.argv[2];
if (command !== 'up' && command !== 'down') {
  throw new Error('Migration command must be "up" or "down".');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const environmentFile = resolve(repositoryRoot, '.env');
const migrationDirectory = resolve(repositoryRoot, 'database', 'migrations');
const migrationCli = resolve(scriptDirectory, '..', 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');

if (existsSync(environmentFile)) {
  loadEnvFile(environmentFile);
}

const result = spawnSync(process.execPath, [migrationCli, command, '-m', migrationDirectory], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

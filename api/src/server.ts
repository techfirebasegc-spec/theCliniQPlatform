import { loadEnvironment } from './config/environment.js';
import { createApp } from './app.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const environmentFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(environmentFile)) loadEnvFile(environmentFile);
const environment = loadEnvironment(process.env);
const { app, services } = createApp(environment);
const host = process.env.API_HOST ?? '127.0.0.1';

async function start(): Promise<void> {
  try {
    await app.listen({ port: environment.API_PORT, host });
  } catch (error) {
    app.log.fatal({ err: error }, 'API startup failed');
    await services.database.close();
    await services.redis.close();
    process.exit(1);
  }
}

void start();

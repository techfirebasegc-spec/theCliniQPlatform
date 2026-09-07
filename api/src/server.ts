import { loadEnvironment } from './config/environment.js';
import { createApp } from './app.js';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('../.env')) loadEnvFile('../.env');
const environment = loadEnvironment(process.env);
const { app, services } = createApp(environment);

async function start(): Promise<void> {
  try {
    await app.listen({ port: environment.API_PORT, host: '127.0.0.1' });
  } catch (error) {
    app.log.fatal({ err: error }, 'API startup failed');
    await services.database.close();
    await services.redis.close();
    process.exit(1);
  }
}

void start();

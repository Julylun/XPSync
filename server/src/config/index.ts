import { resolve } from 'node:path';
export interface Config {
  host: string;
  port: number;
  dbPath: string;
  jwtSecret: string;
  setupToken: string;
  clientOrigins: string[];
}
export function loadConfig(): Config {
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32 || jwtSecret.startsWith('replace-'))
    throw new Error('Set JWT_SECRET to a random value of at least 32 characters.');
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port,
    dbPath: resolve(process.env.DB_PATH ?? './data/xpsync.db'),
    jwtSecret,
    setupToken: process.env.SETUP_TOKEN ?? '',
    clientOrigins: (process.env.CLIENT_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  };
}

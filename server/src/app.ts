import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { Config } from './config/index.js';
import { Store } from './db/store.js';
import { createHub } from './websocket/hub.js';
import { apiRouter } from './routes/api.js';
import { HttpError } from './protocol.js';
export function createApp(config: Config) {
  const store = new Store(config.dbPath),
    app = express(),
    server = createServer(app),
    hub = createHub(server, store, config);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null, 'connect-src': ["'self'", 'ws:', 'wss:'] },
      },
      strictTransportSecurity: false,
      // The dashboard supports plain HTTP on LAN and does not require isolation.
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
    }),
  );
  app.use('/api/client', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (config.clientOrigins.includes('*') || config.clientOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
  app.use(
    '/api',
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    apiRouter(store, hub, config),
  );
  app.get('/', (_req, res) => res.redirect('/admin/'));
  app.use('/admin', express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(
    (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        error instanceof ZodError
          ? 400
          : error instanceof HttpError
            ? error.status
            : error.status === 400 || error.status === 413
              ? error.status
              : 500;
      if (status === 500) console.error('Request failed:', error);
      res
        .status(status)
        .json({
          error:
            status === 500
              ? 'Internal server error'
              : error instanceof ZodError
                ? 'Invalid request: ' +
                  error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')
                : error.message,
        });
    },
  );
  return {
    app,
    server,
    store,
    hub,
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve((server.address() as { port: number }).port);
        });
      });
    },
    async close() {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

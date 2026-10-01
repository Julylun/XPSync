import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { Store } from '../db/store.js';
import type { Hub } from '../websocket/hub.js';
import { checkPassword, hashPassword, issueToken, requireAdmin } from '../middleware/auth.js';
import { HttpError } from '../protocol.js';
export function apiRouter(store: Store, hub: Hub, config: Config) {
  const router = Router();
  const credentials = z.object({
    username: z.string().trim().min(1).max(80),
    password: z.string().min(12).max(256),
  });
  router.get('/auth/status', (_req, res) => res.json({ setupRequired: !store.hasAdmin() }));
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.post('/auth/setup', authLimit, async (req, res) => {
    if (store.hasAdmin()) throw new HttpError(409, 'Setup is already complete');
    const supplied = Buffer.from(String(req.body?.setupToken ?? '')),
      expected = Buffer.from(config.setupToken);
    if (
      !expected.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(403, 'Invalid setup token');
    const input = credentials.parse(req.body),
      hash = await hashPassword(input.password),
      adminId = randomUUID();
    store.db.transaction(() => {
      if (store.hasAdmin()) throw new HttpError(409, 'Setup is already complete');
      store.db
        .prepare('INSERT INTO admins VALUES (?,?,?,?)')
        .run(adminId, input.username, hash, Date.now());
    })();
    res.status(201).json({ token: issueToken(adminId, config.jwtSecret) });
  });
  router.post('/auth/login', authLimit, async (req, res) => {
    const input = credentials.parse(req.body);
    const admin = store.db
      .prepare('SELECT id,password_hash FROM admins WHERE username=?')
      .get(input.username) as { id: string; password_hash: string } | undefined;
    // Always run scrypt to keep missing-user and wrong-password paths comparable.
    const valid = await checkPassword(
      input.password,
      admin?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`,
    );
    if (!admin || !valid) throw new HttpError(401, 'Invalid username or password');
    res.json({ token: issueToken(admin.id, config.jwtSecret) });
  });
  router.use(
    '/client',
    rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  router.post('/client/verify', (req, res) => {
    const key = z.string().min(20).max(200).parse(req.body?.projectApiKey);
    const project = store.verifyKey(key);
    if (!project) throw new HttpError(401, 'Invalid project API key');
    res.json({ project, protocolVersion: 1 });
  });
  router.use(requireAdmin(config.jwtSecret));
  router.get('/projects', (_req, res) =>
    res.json(store.projects().map((p) => ({ ...p, onlineUsers: hub.online(p.id) }))),
  );
  const projectInput = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(''),
  });
  router.post('/projects', (req, res) => {
    const input = projectInput.parse(req.body);
    const project = store.createProject(input.name, input.description);
    hub.adminEvent(project.id);
    res.status(201).json(project);
  });
  router.use('/projects/:id', (req, _res, next) => {
    if (!store.project(String(req.params.id))) throw new HttpError(404, 'Project not found');
    next();
  });
  router.patch('/projects/:id', (req, res) => {
    const input = projectInput.parse(req.body);
    store.db
      .prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?')
      .run(input.name, input.description, Date.now(), req.params.id);
    hub.adminEvent(String(req.params.id));
    res.json(store.project(String(req.params.id)));
  });
  router.post('/projects/:id/regenerate-key', (req, res) => {
    const result = store.rotateKey(String(req.params.id));
    hub.revoke(String(req.params.id));
    res.json(result);
  });
  router.delete('/projects/:id', (req, res) => {
    store.db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
    hub.revoke(String(req.params.id));
    res.status(204).end();
  });
  router.get('/projects/:id/tasks', (req, res) => res.json(store.tasks(String(req.params.id))));
  router.get('/projects/:id/logs', (req, res) => res.json(store.logs(String(req.params.id))));
  return router;
}

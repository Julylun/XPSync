import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config/index.js';
import type { Store } from '../db/store.js';
import { joinSchema, mutationSchema } from '../protocol.js';
import { validToken } from '../middleware/auth.js';
interface Session {
  projectId?: string;
  username?: string;
  originId?: string;
  admin?: boolean;
  alive: boolean;
  count: number;
  window: number;
  expiresAt?: number;
}
export function createHub(server: Server, store: Store, config: Config) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  const sessions = new Map<WebSocket, Session>();
  function send(ws: WebSocket, data: unknown) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(1013, 'Slow consumer');
      else ws.send(JSON.stringify(data));
    }
  }
  function online(projectId: string) {
    return [
      ...new Set(
        [...sessions.values()].filter((s) => s.projectId === projectId).map((s) => s.username!),
      ),
    ];
  }
  function adminEvent(projectId?: string) {
    for (const [ws, s] of sessions) if (s.admin) send(ws, { type: 'admin:changed', projectId });
  }
  function presence(projectId: string) {
    for (const [ws, s] of sessions)
      if (s.projectId === projectId) send(ws, { type: 'presence', users: online(projectId) });
    adminEvent(projectId);
  }
  function revoke(projectId: string) {
    for (const [ws, s] of sessions)
      if (s.projectId === projectId) {
        sessions.delete(ws);
        ws.close(4003, 'Project key revoked');
      }
    presence(projectId);
  }
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (
      origin &&
      !config.clientOrigins.includes('*') &&
      !config.clientOrigins.includes(origin) &&
      origin !== `http://${req.headers.host}` &&
      origin !== `https://${req.headers.host}`
    ) {
      ws.close(4003, 'Origin not allowed');
      return;
    }
    const session: Session = { alive: true, count: 0, window: Date.now() };
    sessions.set(ws, session);
    const authTimeout = setTimeout(() => {
      if (!session.projectId && !session.admin) ws.close(4001, 'Authentication timeout');
    }, 10000);
    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('error', () => ws.close());
    ws.on('message', (raw) => {
      if (!sessions.has(ws) || ws.readyState !== WebSocket.OPEN) return;
      let msg: any;
      try {
        if (Date.now() - session.window >= 1000) {
          session.count = 0;
          session.window = Date.now();
        }
        if (++session.count > 100) {
          ws.close(1008, 'Rate limit exceeded');
          return;
        }
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object') throw new Error('Invalid message');
        if (msg.type === 'admin:join' && !session.projectId && !session.admin) {
          const claims = validToken(msg.token, config.jwtSecret) as { exp: number };
          session.admin = true;
          session.expiresAt = claims.exp * 1000;
          clearTimeout(authTimeout);
          send(ws, { type: 'admin:ready' });
          return;
        }
        if (msg.type === 'join' && !session.projectId && !session.admin) {
          const join = joinSchema.parse(msg),
            project = store.verifyKey(join.projectApiKey);
          if (!project) {
            send(ws, { type: 'error', error: 'Invalid project API key', fatal: true });
            ws.close(4003, 'Invalid API key');
            return;
          }
          Object.assign(session, {
            projectId: project.id,
            username: join.username,
            originId: join.originId,
          });
          clearTimeout(authTimeout);
          send(ws, {
            type: 'snapshot',
            project,
            tasks: store.tasks(project.id, true),
            serverTime: Date.now(),
          });
          presence(project.id);
          return;
        }
        if (!session.projectId) throw new Error('Join a project before sending task events');
        if (msg.type === 'task:full_sync') {
          send(ws, {
            type: 'snapshot',
            project: store.project(session.projectId),
            tasks: store.tasks(session.projectId, true),
            serverTime: Date.now(),
          });
          return;
        }
        const mutation = mutationSchema.parse(msg),
          result = store.apply(session.projectId, session.username!, mutation);
        send(ws, { type: 'task:ack', mutationId: mutation.mutationId, ...result });
        if (result.changed) {
          for (const [peer, s] of sessions)
            if (peer !== ws && s.projectId === session.projectId)
              send(peer, {
                type: 'task:remote_mutation',
                task: result.task,
                tasks: result.tasks,
                originId: session.originId,
              });
          adminEvent(session.projectId);
        }
      } catch (error) {
        send(ws, {
          type: 'error',
          mutationId: typeof msg?.mutationId === 'string' ? msg.mutationId : undefined,
          error: error instanceof Error ? error.message : 'Invalid message',
        });
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimeout);
      sessions.delete(ws);
      if (session.projectId) presence(session.projectId);
    });
  });
  const heartbeat = setInterval(() => {
    for (const [ws, s] of sessions) {
      if (!s.alive || (s.expiresAt && Date.now() >= s.expiresAt)) {
        ws.terminate();
        continue;
      }
      s.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  return {
    online,
    revoke,
    adminEvent,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
export type Hub = ReturnType<typeof createHub>;

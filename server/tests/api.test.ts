import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { Store } from '../src/db/store.js';
import { mutationSchema } from '../src/protocol.js';
const config = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'test-secret-'.repeat(5),
  setupToken: 'setup-token',
  clientOrigins: ['*'],
};
function client(url: string) {
  const ws = new WebSocket(url),
    inbox: any[] = [],
    waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    inbox.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((fn) => fn());
  });
  return {
    ws,
    inbox,
    send(value: unknown) {
      ws.send(JSON.stringify(value));
    },
    async next(type: string) {
      for (let i = 0; i < 50; i++) {
        const index = inbox.findIndex((m) => m.type === type);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise<void>((r) => {
          const timer = setTimeout(r, 100);
          waiters.push(() => {
            clearTimeout(timer);
            r();
          });
        });
      }
      throw new Error('Missing event ' + type);
    },
  };
}
test('admin lifecycle, protected endpoints, key hashing, project CRUD and validation', async (t) => {
  const app = createApp(config);
  const port = await app.listen();
  t.after(() => app.close());
  let token = '';
  const request = (path: string, body?: any, method = body ? 'POST' : 'GET') =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await request('/projects')).status, 401);
  assert.equal(
    (
      await request('/auth/setup', {
        username: 'admin',
        password: 'long-test-password',
        setupToken: 'wrong',
      })
    ).status,
    403,
  );
  const setup = await request('/auth/setup', {
    username: 'admin',
    password: 'long-test-password',
    setupToken: config.setupToken,
  });
  assert.equal(setup.status, 201);
  token = (await setup.json()).token;
  assert.equal((await request('/auth/setup', {})).status, 409);
  assert.equal(
    (await request('/auth/login', { username: 'admin', password: 'wrong-password' })).status,
    401,
  );
  assert.equal(
    (await request('/auth/login', { username: 'admin', password: 'long-test-password' })).status,
    200,
  );
  assert.equal((await request('/projects', { name: '' })).status, 400);
  const p = await (await request('/projects', { name: 'Alpha', description: 'Team' })).json();
  assert.ok(p.apiKey.startsWith('xps_prj_'));
  assert.equal((await request('/client/verify', { projectApiKey: p.apiKey })).status, 200);
  assert.ok(
    !JSON.stringify(app.store.db.prepare('SELECT * FROM projects').all()).includes(p.apiKey),
  );
  assert.equal((await request(`/projects/${p.id}`, { name: 'Beta' }, 'PATCH')).status, 200);
  assert.equal((await request(`/projects/${p.id}/tasks`)).status, 200);
  const newKey = await (await request(`/projects/${p.id}/regenerate-key`, {})).json();
  assert.equal((await request('/client/verify', { projectApiKey: p.apiKey })).status, 401);
  assert.equal((await request('/client/verify', { projectApiKey: newKey.apiKey })).status, 200);
  assert.equal((await request(`/projects/${p.id}`, undefined, 'DELETE')).status, 204);
  assert.equal((await request(`/projects/${p.id}/tasks`)).status, 404);
  const page = await fetch(`http://127.0.0.1:${port}/admin/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('XPSync'));
  assert.ok(page.headers.get('content-security-policy'));
});
test('WebSocket authentication, room isolation, ack, no self-echo, snapshot and key revocation', async (t) => {
  const app = createApp(config),
    port = await app.listen();
  t.after(() => app.close());
  const p = app.store.createProject('Alpha', ''),
    other = app.store.createProject('Other', '');
  const a = client(`ws://127.0.0.1:${port}/ws`),
    b = client(`ws://127.0.0.1:${port}/ws`),
    outsider = client(`ws://127.0.0.1:${port}/ws`),
    invalid = client(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([a, b, outsider, invalid].map((c) => once(c.ws, 'open')));
  for (const [c, key, username] of [
    [a, p.apiKey, 'Alice'],
    [b, p.apiKey, 'Bob'],
    [outsider, other.apiKey, 'Eve'],
    [invalid, 'bad-key-'.repeat(8), 'Bad'],
  ] as const)
    c.send({
      type: 'join',
      projectApiKey: key,
      username,
      originId: randomUUID(),
      clientVersion: '1.0.0',
    });
  assert.equal((await invalid.next('error')).fatal, true);
  await a.next('snapshot');
  await b.next('snapshot');
  await outsider.next('snapshot');
  const m = {
    type: 'task:push_mutation',
    mutationId: randomUUID(),
    taskId: 'task1',
    operation: 'upsert',
    timestamp: Date.now(),
    changes: { title: 'Hello' },
  };
  a.send(m);
  assert.equal((await a.next('task:ack')).task.data.title, 'Hello');
  assert.equal((await b.next('task:remote_mutation')).task.id, 'task1');
  a.send(m);
  assert.equal((await a.next('task:ack')).changed, false);
  assert.equal(app.store.logs(p.id).length, 1);
  assert.equal(app.store.tasks(other.id).length, 0);
  assert.ok(!a.inbox.some((m) => m.type === 'task:remote_mutation'));
  assert.ok(!outsider.inbox.some((m) => m.type === 'task:remote_mutation'));
  b.send({ type: 'task:full_sync' });
  assert.equal((await b.next('snapshot')).tasks.length, 1);
  const closed = once(b.ws, 'close');
  app.store.rotateKey(p.id);
  app.hub.revoke(p.id);
  assert.equal((await closed)[0], 4003);
});
test('field-level LWW merges independent edits, stale updates and deletes cannot win; terminal tombstones', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('P', ''),
      now = Date.now() - 10000;
    const apply = (taskId: string, changes: any, timestamp: number, operation = 'upsert') =>
      store.apply(
        p.id,
        'Alice',
        mutationSchema.parse({
          type: 'task:push_mutation',
          mutationId: randomUUID(),
          taskId,
          operation,
          changes,
          timestamp,
        }),
      );
    apply('a', { title: 'Original', isDone: false }, now);
    apply('a', { title: 'New' }, now + 200);
    apply('a', { isDone: true }, now + 100);
    apply('a', { title: 'Old' }, now + 50);
    assert.deepEqual(
      { title: store.task(p.id, 'a')!.data.title, done: store.task(p.id, 'a')!.data.isDone },
      { title: 'New', done: true },
    );
    assert.equal(apply('a', {}, now + 150, 'delete').changed, false);
    apply('a', {}, now + 300, 'delete');
    assert.equal(apply('a', { title: 'Zombie' }, now + 400).changed, false);
    assert.equal(store.tasks(p.id).length, 0);
    assert.equal(store.tasks(p.id, true).length, 1);
    assert.throws(() => apply('future', { title: 'Future' }, Date.now() + 600000), /clock/);
    assert.throws(() =>
      mutationSchema.parse({
        type: 'task:push_mutation',
        mutationId: 'x',
        taskId: 'x',
        operation: 'upsert',
        timestamp: now,
        changes: { remindAt: 0 },
      }),
    );
  } finally {
    store.close();
  }
});
test('task identity is project-scoped, hierarchy is validated and parent deletion cascades', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('P', ''),
      q = store.createProject('Q', '');
    let stamp = Date.now() - 1000;
    const apply = (projectId: string, taskId: string, changes: any, operation = 'upsert') =>
      store.apply(
        projectId,
        'Alice',
        mutationSchema.parse({
          type: 'task:push_mutation',
          mutationId: randomUUID(),
          taskId,
          changes,
          operation,
          timestamp: stamp++,
        }),
      );
    apply(p.id, 'same', { title: 'Parent' });
    apply(q.id, 'same', { title: 'Other' });
    assert.equal(store.task(q.id, 'same')!.data.title, 'Other');
    apply(p.id, 'child', { title: 'Child', parentId: 'same' });
    assert.throws(() => apply(p.id, 'same', { parentId: 'child' }), /Cyclic/);
    assert.throws(() => apply(q.id, 'x', { title: 'Wrong project', parentId: 'child' }), /Parent/);
    const result = apply(p.id, 'same', {}, 'delete');
    assert.equal(result.tasks.length, 2);
    assert.equal(store.tasks(p.id).length, 0);
    assert.equal(store.tasks(q.id).length, 1);
  } finally {
    store.close();
  }
});

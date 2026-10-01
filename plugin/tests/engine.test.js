import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, normalizeUrl, socketUrl } from '../src/sync-engine.js';
import { MemoryStorage, mockAPI } from './helpers.js';
class OfflineSocket {
  readyState = 0;
  close() {}
}
test('an unavailable local project never becomes mass remote deletion', async (t) => {
  const api = mockAPI(),
    storage = new MemoryStorage();
  const engine = new SyncEngine(api, { storage, WebSocketImpl: OfflineSocket });
  await api.addTask({ title: 'Keep shared task' });
  await engine.start(config);
  t.after(() => engine.stop());
  const c = engine.channels[0],
    baseline = structuredClone(c.state.baseline);
  c.state.outbox = [];
  api.tasks.clear();
  api.getAllProjects = async () => [];
  await assert.rejects(() => engine.scan(c), /chưa sẵn sàng/);
  assert.equal(c.state.outbox.length, 0);
  assert.deepEqual(c.state.baseline, baseline);
});
const config = {
  serverUrl: 'http://localhost:3001',
  username: 'Alice',
  mappings: [
    { localProjectId: 'local-project', serverProjectId: 'server-project', secretId: 'key' },
  ],
};
test('URLs allow explicit HTTP(S) origins and reject credentials, paths and schemes', () => {
  assert.equal(normalizeUrl('https://example.com:3443/'), 'https://example.com:3443');
  assert.equal(socketUrl('https://example.com'), 'wss://example.com/ws');
  for (const value of [
    'file:///tmp',
    'javascript:alert(1)',
    'https://user:pass@host',
    'http://host/path',
    'http://host/?secret=x',
  ])
    assert.throws(() => normalizeUrl(value));
});
test('offline outbox survives reload; unrelated reminders and archived tasks stay local', async (t) => {
  const api = mockAPI(),
    storage = new MemoryStorage();
  let engine = new SyncEngine(api, { storage, WebSocketImpl: OfflineSocket });
  const id = await api.addTask({ title: 'Offline work' });
  await engine.start(config);
  t.after(() => engine.stop());
  assert.equal(engine.channels[0].state.outbox.length, 1);
  const first = engine.channels[0].state.outbox[0].mutationId;
  api.tasks.get(id).remindAt = 98765;
  await engine.scan(engine.channels[0]);
  assert.equal(engine.channels[0].state.outbox.length, 1);
  api.archived.set(id, api.tasks.get(id));
  api.tasks.delete(id);
  await engine.scan(engine.channels[0]);
  assert.equal(engine.channels[0].state.outbox.length, 1);
  engine.stop();
  engine = new SyncEngine(api, { storage, WebSocketImpl: OfflineSocket });
  await engine.start(config);
  assert.equal(engine.channels[0].state.outbox[0].mutationId, first);
  assert.ok(![...storage.values.values()].some((value) => value.includes('test-key')));
});
test('fingerprint echo suppression persists beyond TTL and preserves immediate user edits', async (t) => {
  let now = Date.now();
  const api = mockAPI(),
    engine = new SyncEngine(api, {
      storage: new MemoryStorage(),
      WebSocketImpl: OfflineSocket,
      now: () => now,
    });
  await engine.start(config);
  t.after(() => engine.stop());
  const c = engine.channels[0];
  c.state.remote.remote = {
    id: 'remote',
    deleted: false,
    data: {
      title: 'From Bob',
      notes: '',
      isDone: false,
      timeSpent: 5000,
      timeEstimate: 10000,
      parentId: null,
    },
  };
  await engine.reconcile(c);
  now += 5000;
  await engine.scan(c);
  assert.equal(c.state.outbox.length, 0);
  const task = api.tasks.get(c.state.links.remote);
  task.title = 'Immediate local edit';
  await engine.scan(c);
  assert.deepEqual(c.state.outbox[0].changes, { title: 'Immediate local edit' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { SyncEngine } from '../../plugin/src/sync-engine.js';
import { MemoryStorage, mockAPI, waitFor } from '../../plugin/tests/helpers.js';
test(
  'two actual WebSocket plugin clients converge: creates, edits, hierarchy, restart, offline edits and deletes without echoes',
  { timeout: 30000 },
  async (t) => {
    const app = createApp({
      host: '127.0.0.1',
      port: 0,
      dbPath: ':memory:',
      jwtSecret: 'test'.repeat(16),
      setupToken: 'setup',
      clientOrigins: ['*'],
    });
    const port = await app.listen(),
      project = app.store.createProject('Shared', ''),
      storageA = new MemoryStorage(),
      storageB = new MemoryStorage();
    const apiA = mockAPI('project-a', project.apiKey),
      apiB = mockAPI('project-b', project.apiKey),
      errors: any[] = [];
    const make = (api: any, storage: any) =>
      new SyncEngine(api, {
        storage,
        WebSocketImpl: WebSocket,
        onActivity: (event: any) => {
          if (event.error) errors.push(event.message);
        },
      });
    const config = (username: string, localProjectId: string) => ({
      serverUrl: `http://127.0.0.1:${port}`,
      username,
      mappings: [{ localProjectId, serverProjectId: project.id, secretId: 'key' }],
    });
    const a = make(apiA, storageA);
    let b = make(apiB, storageB);
    t.after(async () => {
      a.stop();
      b.stop();
      await app.close();
    });
    apiA.setOnChange(() => a.scheduleScan());
    apiB.setOnChange(() => b.scheduleScan());
    await a.start(config('Alice', 'project-a'));
    await b.start(config('Bob', 'project-b'));
    await waitFor(
      () => a.status()[0]?.status === 'online' && b.status()[0]?.status === 'online',
      'join',
    );
    const idA = await apiA.addTask({ title: 'Shared task', projectId: 'project-a' });
    await waitFor(() => apiB.tasks.size === 1 && a.status()[0].pending === 0, 'remote create');
    const idB = [...apiB.tasks.keys()][0];
    assert.notEqual(idA, idB);
    await Promise.all([
      apiA.updateTask(idA, { title: 'Design database' }),
      apiB.updateTask(idB, { isDone: true }),
    ]);
    await waitFor(
      () =>
        apiA.tasks.get(idA)?.isDone &&
        apiB.tasks.get(idB)?.title === 'Design database' &&
        !a.status()[0].pending &&
        !b.status()[0].pending,
      'concurrent independent patches',
    );
    assert.equal(apiB.tasks.get(idB).remindAt, 12345);
    const childA = await apiA.addTask({
      title: 'Child task',
      projectId: 'project-a',
      parentId: idA,
    });
    await waitFor(() => apiB.tasks.size === 2 && !a.status()[0].pending, 'subtask create');
    const childB = [...apiB.tasks.values()].find((task: any) => task.title === 'Child task')!;
    assert.equal(childB.parentId, idB);
    assert.ok(apiB.tasks.get(idB).subTaskIds.includes(childB.id));
    // Reparent through the API that maintains both sides of the local relationship.
    await apiA.batchUpdateForProject({
      operations: [{ taskId: childA, updates: { parentId: null } }],
    });
    await waitFor(
      () => apiB.tasks.get(childB.id)?.parentId === null && !a.status()[0].pending,
      'subtask detach',
    );
    b.stop();
    await b.chain;
    await apiB.updateTask(idB, { notes: 'Written offline' });
    await apiA.updateTask(idA, { title: 'While Bob was offline' });
    await waitFor(
      () => app.store.task(project.id, idA)?.data.title === 'While Bob was offline',
      'online edit',
    );
    b = make(apiB, storageB);
    await b.start(config('Bob', 'project-b'));
    await waitFor(
      () =>
        apiA.tasks.get(idA)?.notes === 'Written offline' &&
        apiB.tasks.get(idB)?.title === 'While Bob was offline' &&
        !b.status()[0].pending,
      'offline replay and restart',
    );
    const count = app.store.logs(project.id).length;
    await a.fullSync();
    await b.fullSync();
    await waitFor(() => !a.status()[0].pending && !b.status()[0].pending, 'quiescence');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(app.store.logs(project.id).length, count, 'No echo mutations after full sync');
    assert.equal(apiB.tasks.size, 2, 'Restart must not duplicate tasks');
    b.stop();
    await b.chain;
    await apiB.updateTask(idB, { title: 'Stale offline resurrection' });
    await apiA.deleteTask(idA);
    await waitFor(() => app.store.task(project.id, idA)?.deleted, 'delete');
    b = make(apiB, storageB);
    await b.start(config('Bob', 'project-b'));
    await waitFor(
      () => !apiB.tasks.has(idB) && !b.status()[0].pending,
      'tombstone takes precedence on reconnect',
    );
    assert.equal(apiB.tasks.size, 1);
    assert.deepEqual(errors, []);
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/db/store.js';
test('SQLite tasks, versions, receipts and tombstones survive server restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xpsync-test-')),
    path = join(dir, 'test.db');
  let store = new Store(path);
  try {
    const p = store.createProject('Persistent', ''),
      mutation = {
        type: 'task:push_mutation' as const,
        taskId: 'task',
        mutationId: 'create-1',
        operation: 'upsert' as const,
        timestamp: Date.now(),
        changes: { title: 'Persisted' },
      };
    store.apply(p.id, 'Alice', mutation);
    store.close();
    store = new Store(path);
    assert.equal(store.verifyKey(p.apiKey)?.id, p.id);
    assert.equal(store.task(p.id, 'task')?.data.title, 'Persisted');
    assert.equal(store.apply(p.id, 'Alice', mutation).changed, false);
    store.apply(p.id, 'Alice', {
      ...mutation,
      mutationId: 'delete-1',
      operation: 'delete',
      timestamp: mutation.timestamp + 1,
      changes: {},
    });
    store.close();
    store = new Store(path);
    assert.equal(store.task(p.id, 'task')?.deleted, true);
    assert.equal(store.tasks(p.id).length, 0);
  } finally {
    store.close();
    if (
      resolve(dir).startsWith(resolve(tmpdir()) + '\\') ||
      resolve(dir).startsWith(resolve(tmpdir()) + '/')
    )
      rmSync(dir, { recursive: true, force: true });
  }
});

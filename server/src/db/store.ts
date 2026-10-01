import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  HttpError,
  type Mutation,
  type SyncTask,
  type TaskData,
  type Version,
} from '../protocol.js';
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
export interface Project {
  id: string;
  name: string;
  description: string;
  key_prefix: string;
  created_at: number;
  updated_at: number;
}
export class Store {
  db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, api_key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL, versions TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, last_updated_by TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_name TEXT NOT NULL, action TEXT NOT NULL, task_title TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_project_time ON activity_logs(project_id, id DESC);
      CREATE TABLE IF NOT EXISTS mutations (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, mutation_id TEXT NOT NULL, PRIMARY KEY(project_id,mutation_id));
      PRAGMA user_version = 1;
    `);
  }
  hasAdmin() {
    return !!this.db.prepare('SELECT id FROM admins LIMIT 1').get();
  }
  project(projectId: string) {
    return this.db
      .prepare(
        'SELECT id,name,description,key_prefix,created_at,updated_at FROM projects WHERE id=?',
      )
      .get(projectId) as Project | undefined;
  }
  verifyKey(key: string) {
    return this.db
      .prepare('SELECT id,name FROM projects WHERE api_key_hash=?')
      .get(hashKey(key)) as { id: string; name: string } | undefined;
  }
  createProject(name: string, description: string) {
    const apiKey = 'xps_prj_' + randomBytes(32).toString('hex'),
      projectId = randomUUID(),
      now = Date.now();
    this.db
      .prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)')
      .run(projectId, name, description, hashKey(apiKey), apiKey.slice(0, 16), now, now);
    return { ...this.project(projectId)!, apiKey };
  }
  rotateKey(projectId: string) {
    if (!this.project(projectId)) throw new HttpError(404, 'Project not found');
    const apiKey = 'xps_prj_' + randomBytes(32).toString('hex');
    this.db
      .prepare('UPDATE projects SET api_key_hash=?,key_prefix=?,updated_at=? WHERE id=?')
      .run(hashKey(apiKey), apiKey.slice(0, 16), Date.now(), projectId);
    return { apiKey };
  }
  projects() {
    return this.db
      .prepare(
        `SELECT p.id,p.name,p.description,p.key_prefix,p.created_at,p.updated_at, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted=0) AS taskCount FROM projects p ORDER BY p.created_at DESC`,
      )
      .all() as (Project & { taskCount: number })[];
  }
  decode(row: any): SyncTask {
    return {
      id: row.id,
      projectId: row.project_id,
      data: JSON.parse(row.data),
      versions: JSON.parse(row.versions),
      deleted: !!row.deleted,
      updatedAt: row.updated_at,
      lastUpdatedBy: row.last_updated_by,
    };
  }
  task(projectId: string, taskId: string) {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_id=? AND id=?')
      .get(projectId, taskId);
    return row ? this.decode(row) : undefined;
  }
  tasks(projectId: string, tombstones = false) {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE project_id=? ${tombstones ? '' : 'AND deleted=0'} ORDER BY updated_at,id`,
      )
      .all(projectId)
      .map((r) => this.decode(r));
  }
  logs(projectId: string) {
    return this.db
      .prepare('SELECT * FROM activity_logs WHERE project_id=? ORDER BY id DESC LIMIT 100')
      .all(projectId);
  }
  apply(
    projectId: string,
    username: string,
    mutation: Mutation,
  ): { task: SyncTask; tasks: SyncTask[]; changed: boolean } {
    if (mutation.timestamp > Date.now() + 300000)
      throw new HttpError(400, 'Client clock is more than five minutes ahead');
    return this.db.transaction(() => {
      const previous = this.task(projectId, mutation.taskId);
      if (
        this.db
          .prepare('SELECT 1 FROM mutations WHERE project_id=? AND mutation_id=?')
          .get(projectId, mutation.mutationId)
      ) {
        if (!previous) throw new HttpError(409, 'Mutation ID already used');
        return { task: previous, tasks: [previous], changed: false };
      }
      if (!previous && mutation.operation === 'upsert' && !mutation.changes.title)
        throw new HttpError(400, 'A new task requires a title');
      const task: SyncTask = previous ?? {
        id: mutation.taskId,
        projectId,
        data: {
          title: '',
          isDone: false,
          notes: '',
          timeSpent: 0,
          timeEstimate: 0,
          parentId: null,
        },
        versions: {},
        deleted: false,
        updatedAt: 0,
        lastUpdatedBy: username,
      };
      const version: Version = [mutation.timestamp, mutation.mutationId];
      const newer = (old?: Version) =>
        !old || version[0] > old[0] || (version[0] === old[0] && version[1] > old[1]);
      let changed = false;
      // Tombstones are terminal: reconnecting clients cannot resurrect deleted IDs.
      if (!task.deleted) {
        if (mutation.operation === 'delete') {
          if (Object.values(task.versions).every(newer)) {
            task.deleted = true;
            task.versions.deleted = version;
            changed = true;
          }
        } else {
          for (const [field, value] of Object.entries(mutation.changes)) {
            if (newer(task.versions[field])) {
              (task.data as any)[field] = value;
              task.versions[field] = version;
              changed = true;
            }
          }
          // Parent links are scoped to this project. Reject cycles and missing parents.
          if (task.data.parentId) {
            const visited = new Set([task.id]);
            let parentId: string | null = task.data.parentId;
            while (parentId) {
              if (visited.has(parentId)) throw new HttpError(400, 'Cyclic task hierarchy');
              visited.add(parentId);
              const parent = this.task(projectId, parentId);
              if (!parent || parent.deleted) throw new HttpError(400, 'Parent task not found');
              parentId = parent.data.parentId;
            }
          }
        }
      }
      const affected: SyncTask[] = [];
      if (changed) {
        task.updatedAt = Math.max(task.updatedAt, mutation.timestamp);
        task.lastUpdatedBy = username;
        this.db
          .prepare(
            'INSERT INTO tasks VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data,versions=excluded.versions,deleted=excluded.deleted,updated_at=excluded.updated_at,last_updated_by=excluded.last_updated_by',
          )
          .run(
            task.id,
            projectId,
            JSON.stringify(task.data),
            JSON.stringify(task.versions),
            Number(task.deleted),
            task.updatedAt,
            username,
          );
        this.db
          .prepare(
            'INSERT INTO activity_logs(project_id,user_name,action,task_title,timestamp) VALUES (?,?,?,?,?)',
          )
          .run(
            projectId,
            username,
            task.deleted ? 'DELETE' : previous ? 'UPDATE' : 'CREATE',
            task.data.title || task.id,
            Date.now(),
          );
        affected.push(task);
        if (task.deleted) {
          const all = this.tasks(projectId),
            deletedIds = new Set([task.id]);
          let added = true;
          while (added) {
            added = false;
            for (const child of all)
              if (
                !deletedIds.has(child.id) &&
                child.data.parentId &&
                deletedIds.has(child.data.parentId)
              ) {
                deletedIds.add(child.id);
                added = true;
              }
          }
          for (const child of all)
            if (deletedIds.has(child.id)) {
              child.deleted = true;
              child.updatedAt = Math.max(child.updatedAt, mutation.timestamp);
              child.lastUpdatedBy = username;
              child.versions.deleted = [child.updatedAt, mutation.mutationId];
              this.db
                .prepare(
                  'UPDATE tasks SET deleted=1,versions=?,updated_at=?,last_updated_by=? WHERE project_id=? AND id=?',
                )
                .run(
                  JSON.stringify(child.versions),
                  child.updatedAt,
                  username,
                  projectId,
                  child.id,
                );
              this.db
                .prepare(
                  'INSERT INTO activity_logs(project_id,user_name,action,task_title,timestamp) VALUES (?,?,?,?,?)',
                )
                .run(projectId, username, 'DELETE', child.data.title, Date.now());
              affected.push(child);
            }
        }
      }
      this.db.prepare('INSERT INTO mutations VALUES (?,?)').run(projectId, mutation.mutationId);
      return { task, tasks: affected.length ? affected : [task], changed };
    })();
  }
  close() {
    this.db.close();
  }
}

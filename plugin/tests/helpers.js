import { randomUUID } from 'node:crypto';
export class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
}
export function mockAPI(projectId = 'local-project', key = 'test-key') {
  const tasks = new Map(),
    archived = new Map(),
    calls = [];
  let onChange = () => {};
  const api = {
    tasks,
    archived,
    calls,
    setOnChange(fn) {
      onChange = fn;
    },
    async getTasks() {
      return structuredClone([...tasks.values()]);
    },
    async getAllProjects() {
      return [{ id: projectId, title: projectId }];
    },
    async getArchivedTasks() {
      return structuredClone([...archived.values()]);
    },
    async getSecret() {
      return key;
    },
    async addTask(data) {
      if ('id' in data || 'timeSpent' in data) throw new Error('Unsupported create fields');
      if (data.parentId && !tasks.has(data.parentId)) throw new Error('Parent not found');
      const id = randomUUID();
      tasks.set(id, {
        id,
        title: data.title,
        isDone: data.isDone || false,
        notes: data.notes || '',
        timeSpent: 0,
        timeEstimate: data.timeEstimate || 0,
        projectId: data.projectId || projectId,
        parentId: data.parentId || null,
        subTaskIds: [],
        tagIds: [],
        remindAt: 12345,
      });
      if (data.parentId) tasks.get(data.parentId).subTaskIds.push(id);
      calls.push(['add', id]);
      onChange();
      return id;
    },
    async updateTask(id, updates) {
      if ('parentId' in updates || 'subTaskIds' in updates)
        throw new Error('Relational fields require batchUpdateForProject');
      if (!tasks.has(id)) throw new Error('Task missing');
      Object.assign(tasks.get(id), updates);
      calls.push(['update', id]);
      onChange();
    },
    async batchUpdateForProject({ operations }) {
      for (const op of operations) {
        const task = tasks.get(op.taskId);
        if (task.parentId && tasks.has(task.parentId))
          tasks.get(task.parentId).subTaskIds = tasks
            .get(task.parentId)
            .subTaskIds.filter((id) => id !== task.id);
        Object.assign(task, op.updates);
        if (task.parentId) tasks.get(task.parentId).subTaskIds.push(task.id);
      }
      onChange();
      return { success: true, createdTaskIds: {} };
    },
    async deleteTask(id) {
      const task = tasks.get(id);
      if (!task) throw new Error('Task missing');
      for (const child of [...tasks.values()])
        if (child.parentId === id) await api.deleteTask(child.id);
      if (task.parentId && tasks.has(task.parentId))
        tasks.get(task.parentId).subTaskIds = tasks
          .get(task.parentId)
          .subTaskIds.filter((x) => x !== id);
      tasks.delete(id);
      calls.push(['delete', id]);
      onChange();
    },
  };
  return api;
}
export async function waitFor(check, message = 'condition', timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for ' + message);
}

export const FIELDS = ['title', 'isDone', 'notes', 'timeSpent', 'timeEstimate', 'parentId'];
export function normalizeUrl(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error(
      'Dùng URL gốc http(s)://host:port, không kèm đường dẫn hoặc thông tin đăng nhập.',
    );
  return url.origin;
}
export function socketUrl(value) {
  return normalizeUrl(value).replace(/^http/, 'ws') + '/ws';
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class SyncEngine {
  constructor(
    api,
    {
      storage = localStorage,
      WebSocketImpl = WebSocket,
      uuid = () => crypto.randomUUID(),
      now = () => Date.now(),
      onActivity = () => {},
    } = {},
  ) {
    this.api = api;
    this.storage = storage;
    this.WebSocket = WebSocketImpl;
    this.uuid = uuid;
    this.now = now;
    this.onActivity = onActivity;
    this.channels = [];
    this.chain = Promise.resolve();
    this.stopped = true;
    this.remoteApplyingTaskIds = new Map();
    this.originId = storage.getItem('xpsync:origin') || uuid();
    storage.setItem('xpsync:origin', this.originId);
  }
  enqueue(fn) {
    const result = this.chain.then(() => {
      if (!this.stopped) return fn();
    });
    this.chain = result.catch((e) => this.report(e));
    return result;
  }
  report(error, channel) {
    const message = error instanceof Error ? error.message : String(error);
    if (channel) {
      channel.status = 'error';
      channel.error = message;
    }
    this.onActivity({ timestamp: this.now(), message, error: true });
  }
  save(channel) {
    this.storage.setItem(channel.storageKey, JSON.stringify(channel.state));
  }
  async start(config) {
    this.stopped = false;
    this.config = config;
    for (const mapping of config.mappings) {
      const storageKey = `xpsync:v1:${config.serverUrl}:${mapping.serverProjectId}:${mapping.localProjectId}`;
      const raw = this.storage.getItem(storageKey);
      const state = raw
        ? JSON.parse(raw)
        : { links: {}, baseline: {}, remote: {}, outbox: [], clock: 0 };
      const channel = {
        mapping,
        state,
        storageKey,
        status: 'connecting',
        users: [],
        retry: 0,
        ready: false,
        key: await this.api.getSecret(mapping.secretId),
      };
      if (this.stopped) return;
      this.channels.push(channel);
      if (!channel.key) {
        channel.status = 'error';
        channel.error = 'Nhập lại API key trên thiết bị này.';
        continue;
      }
      // Capture persisted-baseline differences before the first server snapshot.
      try {
        await this.scan(channel);
        this.connect(channel);
      } catch (error) {
        this.report(error, channel);
      }
    }
    if (!this.stopped) this.poll = setInterval(() => this.scheduleScan(), 10000);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.scanTimer);
    for (const c of this.channels) {
      clearTimeout(c.reconnectTimer);
      clearTimeout(c.ackTimer);
      clearTimeout(c.joinTimer);
      if (c.socket) {
        c.socket.onclose = null;
        c.socket.close();
      }
    }
  }
  status() {
    return this.channels.map((c) => ({
      localProjectId: c.mapping.localProjectId,
      status: c.status,
      error: c.error,
      onlineUsers: c.users,
      pending: c.state.outbox.length,
    }));
  }
  scheduleScan() {
    if (this.stopped || this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.enqueue(async () => {
        for (const c of this.channels) {
          try {
            await this.scan(c);
            if (c.ready) {
              await this.reconcile(c);
              this.save(c);
            }
            this.flush(c);
          } catch (error) {
            this.report(error, c);
          }
        }
      }).catch(() => {});
    }, 120);
  }
  connect(c) {
    if (this.stopped) return;
    c.status = 'connecting';
    c.ready = false;
    c.inflight = null;
    c.error = undefined;
    try {
      c.socket = new this.WebSocket(socketUrl(this.config.serverUrl));
    } catch (e) {
      this.report(e, c);
      this.reconnect(c);
      return;
    }
    const ws = c.socket;
    c.joinTimer = setTimeout(() => ws.close(), 12000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'join',
          projectApiKey: c.key,
          username: this.config.username,
          originId: this.originId,
          clientVersion: '1.0.0',
        }),
      );
    ws.onmessage = (event) => {
      void this.enqueue(() => this.receive(c, JSON.parse(event.data))).catch((e) => {
        this.report(e, c);
        ws.close();
      });
    };
    ws.onerror = () => {
      c.error = 'Không thể kết nối. Kiểm tra URL, HTTPS và mạng.';
    };
    ws.onclose = (event) => {
      clearTimeout(c.joinTimer);
      clearTimeout(c.ackTimer);
      c.ready = false;
      c.inflight = null;
      if (event.code === 4003) {
        c.status = 'error';
        c.error =
          'API key bị từ chối/thu hồi, hoặc origin không được phép. Lưu lại cấu hình để thử lại.';
        return;
      }
      if (!this.stopped) {
        c.status = 'offline';
        this.reconnect(c);
      }
    };
  }
  reconnect(c) {
    clearTimeout(c.reconnectTimer);
    c.reconnectTimer = setTimeout(
      () => this.connect(c),
      Math.min(30000, 1000 * 2 ** Math.min(c.retry++, 5)) + Math.random() * 400,
    );
  }
  mutation(c, taskId, operation, changes = {}) {
    c.state.clock = Math.max(this.now(), c.state.clock + 1);
    c.state.outbox.push({
      type: 'task:push_mutation',
      mutationId: this.uuid(),
      taskId,
      operation,
      changes,
      timestamp: c.state.clock,
    });
  }
  localData(task, inverse) {
    return {
      title: task.title,
      isDone: !!task.isDone,
      notes: task.notes || '',
      timeSpent: task.timeSpent || 0,
      timeEstimate: task.timeEstimate || 0,
      parentId: task.parentId ? inverse.get(task.parentId) || null : null,
    };
  }
  async scan(c) {
    // Missing or archived projects can mean SP has not loaded its data yet.
    // Never turn an unavailable project into deletion of every shared task.
    const projects = await this.api.getAllProjects();
    if (!projects.some((p) => p.id === c.mapping.localProjectId && !p.isArchived)) {
      throw new Error(
        'Dự án cục bộ chưa sẵn sàng hoặc đã archive. Kiểm tra mapping rồi bấm Sync ngay bây giờ.',
      );
    }
    const tasks = await this.api.getTasks(),
      byId = new Map(tasks.map((t) => [t.id, t]));
    const projectOf = (task) => {
      const seen = new Set();
      while (task?.parentId && !seen.has(task.id)) {
        seen.add(task.id);
        task = byId.get(task.parentId) || task;
        if (seen.has(task.id)) break;
      }
      return task?.projectId;
    };
    const local = tasks.filter((t) => projectOf(t) === c.mapping.localProjectId);
    const inverse = new Map(Object.entries(c.state.links).map(([remote, id]) => [id, remote]));
    for (const task of local) {
      if (!inverse.has(task.id)) {
        // A local ID is a stable remote ID for locally-created tasks. Received tasks use addTask's returned ID.
        const remoteId = c.state.remote[task.id]?.deleted ? this.uuid() : task.id;
        c.state.links[remoteId] = task.id;
        inverse.set(task.id, remoteId);
      }
    }
    const depth = (task) => {
      let n = 0;
      const seen = new Set();
      while (task?.parentId && !seen.has(task.id)) {
        seen.add(task.id);
        task = byId.get(task.parentId);
        n++;
      }
      return n;
    };
    local.sort((a, b) => depth(a) - depth(b));
    for (const task of local) {
      const id = inverse.get(task.id),
        data = this.localData(task, inverse),
        baseline = c.state.baseline[id];
      // A remote deletion is applied by reconcile, never converted into a new create.
      if (c.state.remote[id]?.deleted) continue;
      const changes = Object.fromEntries(
        FIELDS.filter((f) => !baseline || !equal(data[f], baseline[f])).map((f) => [f, data[f]]),
      );
      if (Object.keys(changes).length) {
        this.mutation(c, id, 'upsert', changes);
        c.state.baseline[id] = data;
      }
    }
    const missing = Object.entries(c.state.links).filter(
      ([id, localId]) =>
        c.state.baseline[id] &&
        !local.some((t) => t.id === localId) &&
        !c.state.remote[id]?.deleted,
    );
    if (missing.length) {
      // Archiving is local-only. Its absence from getTasks() is not a team deletion.
      const archived = new Set((await this.api.getArchivedTasks()).map((t) => t.id));
      const remoteDepth = (id) => {
        let n = 0;
        const seen = new Set();
        while (c.state.baseline[id]?.parentId && !seen.has(id)) {
          seen.add(id);
          id = c.state.baseline[id].parentId;
          n++;
        }
        return n;
      };
      missing.sort(([a], [b]) => remoteDepth(b) - remoteDepth(a));
      for (const [id, localId] of missing)
        if (!archived.has(localId)) {
          this.mutation(c, id, 'delete');
          delete c.state.baseline[id];
        }
    }
    this.save(c);
    for (const [id, until] of this.remoteApplyingTaskIds)
      if (until < this.now()) this.remoteApplyingTaskIds.delete(id);
  }
  flush(c) {
    if (this.stopped || !c.ready || c.inflight || c.blocked || c.socket?.readyState !== 1) return;
    const mutation = c.state.outbox[0];
    if (!mutation) return;
    // Persist before sending, then remove only after an acknowledgement. Retries are idempotent.
    this.save(c);
    c.inflight = mutation.mutationId;
    c.socket.send(JSON.stringify(mutation));
    c.ackTimer = setTimeout(() => c.socket.close(), 15000);
  }
  async receive(c, msg) {
    if (msg.type === 'presence') {
      c.users = msg.users;
      return;
    }
    if (msg.type === 'error') {
      c.blocked = !!msg.mutationId;
      clearTimeout(c.ackTimer);
      c.inflight = null;
      this.report(new Error(msg.error), c);
      return;
    }
    if (!['snapshot', 'task:ack', 'task:remote_mutation'].includes(msg.type)) return;
    await this.scan(c);
    if (msg.type === 'snapshot') {
      if (msg.project.id !== c.mapping.serverProjectId)
        throw new Error('API key trỏ tới dự án khác. Hãy lưu lại mapping.');
      clearTimeout(c.joinTimer);
      c.retry = 0;
      c.ready = true;
      c.status = 'online';
      c.error = undefined;
      c.state.remote = Object.fromEntries(msg.tasks.map((t) => [t.id, t]));
    } else {
      for (const task of msg.tasks || [msg.task]) c.state.remote[task.id] = task;
      if (msg.type === 'task:ack') {
        clearTimeout(c.ackTimer);
        c.state.outbox = c.state.outbox.filter((m) => m.mutationId !== msg.mutationId);
        c.inflight = null;
      } else
        this.onActivity({
          timestamp: this.now(),
          message: `${msg.task.lastUpdatedBy}: ${msg.task.deleted ? 'đã xóa' : 'đã cập nhật'} “${msg.task.data.title}”`,
        });
    }
    // Terminal tombstones cancel even unsent edits of the same task.
    c.state.outbox = c.state.outbox.filter((m) => !c.state.remote[m.taskId]?.deleted);
    this.save(c);
    await this.reconcile(c);
    this.save(c);
    this.flush(c);
  }
  async reconcile(c) {
    let local = await this.api.getTasks(),
      byId = new Map(local.map((t) => [t.id, t]));
    const archived = new Set((await this.api.getArchivedTasks()).map((t) => t.id));
    const desired = new Map();
    for (const remote of Object.values(c.state.remote))
      desired.set(remote.id, { ...copy(remote), data: { ...remote.data } });
    for (const mutation of c.state.outbox) {
      let task = desired.get(mutation.taskId);
      if (!task) {
        task = { id: mutation.taskId, data: {}, deleted: false };
        desired.set(task.id, task);
      }
      if (mutation.operation === 'delete') task.deleted = true;
      else Object.assign(task.data, mutation.changes);
    }
    const visited = new Set();
    const apply = async (id, ancestors = new Set()) => {
      if (visited.has(id)) return;
      if (ancestors.has(id)) throw new Error('Quan hệ task bị vòng lặp.');
      const remote = desired.get(id);
      if (!remote) return;
      let localId = c.state.links[id],
        current = byId.get(localId);
      if (archived.has(localId)) {
        visited.add(id);
        return;
      }
      if (remote.deleted) {
        // Delete descendants first, matching Super Productivity's cascade semantics.
        for (const child of desired.values())
          if (child.data.parentId === id && child.deleted)
            await apply(child.id, new Set([...ancestors, id]));
        if (current && this.belongs(current, byId, c.mapping.localProjectId)) {
          this.remoteApplyingTaskIds.set(localId, this.now() + 2000);
          await this.api.deleteTask(localId);
          byId.delete(localId);
        }
        delete c.state.baseline[id];
        visited.add(id);
        return;
      }
      const parentRemoteId = remote.data.parentId;
      if (parentRemoteId) await apply(parentRemoteId, new Set([...ancestors, id]));
      const parentId = parentRemoteId ? c.state.links[parentRemoteId] : null;
      if (parentRemoteId && (!parentId || !byId.has(parentId))) {
        visited.add(id);
        return;
      }
      if (!current) {
        const { title, notes, timeEstimate, isDone } = remote.data;
        localId = await this.api.addTask({
          title,
          notes,
          timeEstimate,
          isDone,
          projectId: c.mapping.localProjectId,
          parentId,
        });
        c.state.links[id] = localId;
        this.save(c);
        current = (await this.api.getTasks()).find((t) => t.id === localId);
        if (!current) throw new Error('Super Productivity chưa trả về task vừa tạo.');
        byId.set(localId, current);
      }
      if (!this.belongs(current, byId, c.mapping.localProjectId)) {
        visited.add(id);
        return;
      }
      this.remoteApplyingTaskIds.set(localId, this.now() + 2000);
      if ((current.parentId || null) !== parentId) {
        const result = await this.api.batchUpdateForProject({
          projectId: c.mapping.localProjectId,
          operations: [{ type: 'update', taskId: localId, updates: { parentId } }],
        });
        if (!result.success)
          throw new Error(
            result.errors?.map((e) => e.message).join('; ') || 'Không thể cập nhật quan hệ task.',
          );
      }
      const updates = Object.fromEntries(
        FIELDS.filter(
          (f) => f !== 'parentId' && !equal(current[f] ?? (f === 'notes' ? '' : 0), remote.data[f]),
        ).map((f) => [f, remote.data[f]]),
      );
      if (Object.keys(updates).length) await this.api.updateTask(localId, updates);
      // A value baseline suppresses remote echoes even after the 2s marker expires.
      // Only expected fields are recorded, so an unrelated user edit isn't swallowed.
      c.state.baseline[id] = copy(remote.data);
      byId.set(localId, {
        ...current,
        ...remote.data,
        parentId,
        id: localId,
        projectId: c.mapping.localProjectId,
      });
      visited.add(id);
    };
    for (const id of desired.keys()) await apply(id);
  }
  belongs(task, byId, projectId) {
    const seen = new Set();
    while (task?.parentId && !seen.has(task.id)) {
      seen.add(task.id);
      task = byId.get(task.parentId);
    }
    return task?.projectId === projectId;
  }
  async fullSync() {
    return this.enqueue(async () => {
      for (const c of this.channels) {
        await this.scan(c);
        c.blocked = false;
        if (c.ready && c.socket?.readyState === 1) {
          c.socket.send(JSON.stringify({ type: 'task:full_sync' }));
          this.flush(c);
        } else if (c.key) {
          clearTimeout(c.reconnectTimer);
          if (c.socket) {
            c.socket.onclose = null;
            c.socket.close();
          }
          this.connect(c);
        }
      }
    });
  }
}

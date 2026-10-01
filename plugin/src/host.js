import { SyncEngine, normalizeUrl } from './sync-engine.js';
const api = PluginAPI;
let engine,
  config = { serverUrl: '', username: '', mappings: [] },
  activity = [],
  commandChain = Promise.resolve();
const record = (item) => {
  activity.unshift(item);
  activity = activity.slice(0, 5);
};
async function verify(serverUrl, projectApiKey) {
  const response = await fetch(normalizeUrl(serverUrl) + '/api/client/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectApiKey }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không thể xác thực API key.');
  return data.project;
}
async function restart() {
  engine?.stop();
  if (engine) await engine.chain;
  engine = new SyncEngine(api, { onActivity: record });
  if (config.serverUrl && config.username && config.mappings.length) await engine.start(config);
}
async function handle(message) {
  if (message?.type === 'status')
    return {
      config,
      channels: engine?.status() || [],
      activity,
      projects: await api.getAllProjects(),
    };
  if (message?.type === 'verify') return verify(message.serverUrl, message.apiKey);
  if (message?.type === 'createProject') {
    const title = String(message.title || '').trim();
    if (!title || title.length > 120) throw new Error('Tên dự án cần từ 1–120 ký tự.');
    return api.addProject({ title });
  }
  if (message?.type === 'sync') {
    await engine?.fullSync();
    return { success: true };
  }
  if (message?.type === 'save') {
    const serverUrl = normalizeUrl(message.serverUrl),
      username = String(message.username || '').trim();
    if (!username || username.length > 80) throw new Error('Tên người dùng cần từ 1–80 ký tự.');
    if (!Array.isArray(message.mappings) || message.mappings.length > 20)
      throw new Error('Tối đa 20 mapping.');
    const projects = await api.getAllProjects(),
      mappings = [],
      secrets = [];
    for (const m of message.mappings) {
      if (!projects.some((p) => p.id === m.localProjectId))
        throw new Error('Dự án cục bộ không tồn tại.');
      if (mappings.some((x) => x.localProjectId === m.localProjectId))
        throw new Error('Mỗi dự án cục bộ chỉ được ghép nối một lần.');
      const old =
        config.serverUrl === serverUrl &&
        config.mappings.find((x) => x.localProjectId === m.localProjectId);
      const apiKey = m.apiKey?.trim() || (old ? await api.getSecret(old.secretId) : null);
      if (!apiKey) throw new Error('Nhập API key cho mỗi mapping.');
      const project = await verify(serverUrl, apiKey);
      if (mappings.some((x) => x.serverProjectId === project.id))
        throw new Error('Không ghép một dự án server vào hai dự án trên cùng thiết bị.');
      const secretId = old?.secretId || 'project-' + crypto.randomUUID();
      secrets.push([secretId, apiKey]);
      mappings.push({
        localProjectId: m.localProjectId,
        serverProjectId: project.id,
        serverProjectName: project.name,
        secretId,
      });
    }
    // Credentials never enter synced configuration, status responses, logs or browser storage.
    for (const [id, key] of secrets) await api.setSecret(id, key);
    const next = { serverUrl, username, mappings };
    await api.persistDataSynced(JSON.stringify(next));
    config = next;
    await restart();
    return { success: true };
  }
  throw new Error('Lệnh không được hỗ trợ.');
}
async function init() {
  try {
    for (const method of [
      'setSecret',
      'getSecret',
      'onMessage',
      'getArchivedTasks',
      'batchUpdateForProject',
    ])
      if (typeof api[method] !== 'function')
        throw new Error(
          'Hãy cập nhật Super Productivity để dùng Secret Storage và API plugin hiện tại.',
        );
    const saved = await api.loadSyncedData();
    if (saved) config = JSON.parse(saved);
    api.onMessage((message) => {
      const job = commandChain.then(() => handle(message));
      commandChain = job.catch(() => {});
      return job;
    });
    api.registerHeaderButton({
      label: 'XPSync',
      icon: 'sync',
      onClick: () => api.showIndexHtmlAsView(),
    });
    for (const hook of ['taskComplete', 'taskUpdate', 'taskDelete', 'action'])
      api.registerHook(hook, () => engine?.scheduleScan());
    await restart();
  } catch (error) {
    api.showSnack({ msg: `XPSync: ${error.message}`, type: 'ERROR' });
  }
}
api.onUnload?.(() => engine?.stop());
if (api.onReady) api.onReady(init);
else void init();

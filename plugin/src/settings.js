const $ = (id) => document.getElementById(id);
let projects = [],
  loaded = false,
  pollBusy = false;
function message(payload) {
  return new Promise((resolve, reject) => {
    const messageId = crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(
        new Error('Plugin không phản hồi. Hãy bật lại plugin hoặc cập nhật Super Productivity.'),
      );
    }, 45000);
    function handler(event) {
      if (
        event.source !== window.parent ||
        event.data?.messageId !== messageId ||
        !['PLUGIN_MESSAGE_RESPONSE', 'PLUGIN_MESSAGE_ERROR'].includes(event.data?.type)
      )
        return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (event.data.type === 'PLUGIN_MESSAGE_ERROR')
        reject(new Error(event.data.error || 'Yêu cầu thất bại.'));
      else resolve(event.data.result);
    }
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: 'PLUGIN_MESSAGE', messageId, message: payload }, '*');
  });
}
function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').className = error ? 'error' : '';
}
function addMapping(mapping = {}) {
  const row = document.createElement('div');
  row.className = 'mapping';
  const selectLabel = document.createElement('label');
  selectLabel.textContent = 'Dự án cục bộ';
  const select = document.createElement('select');
  select.className = 'local-project';
  select.required = true;
  for (const project of projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.title;
    select.append(option);
  }
  if (mapping.localProjectId) select.value = mapping.localProjectId;
  selectLabel.append(select);
  const keyLabel = document.createElement('label');
  keyLabel.textContent = 'Project API key';
  const key = document.createElement('input');
  key.type = 'password';
  key.className = 'api-key';
  key.autocomplete = 'off';
  key.placeholder = mapping.secretId ? 'Để trống để giữ key trên thiết bị' : 'xps_prj_…';
  keyLabel.append(key);
  const actions = document.createElement('div');
  actions.className = 'toolbar';
  const check = document.createElement('button');
  check.type = 'button';
  check.textContent = 'Kiểm tra';
  check.onclick = async () => {
    check.disabled = true;
    try {
      if (!key.value.trim())
        throw new Error('Nhập key để kiểm tra, hoặc bấm Lưu & Kết nối để dùng key đã lưu.');
      const project = await message({
        type: 'verify',
        serverUrl: $('server-url').value,
        apiKey: key.value.trim(),
      });
      feedback('Kết nối hợp lệ: ' + project.name);
    } catch (e) {
      feedback(e.message, true);
    } finally {
      check.disabled = false;
    }
  };
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Bỏ';
  remove.onclick = () => row.remove();
  actions.append(check, remove);
  const status = document.createElement('small');
  status.className = 'mapping-status';
  status.textContent = mapping.serverProjectName || 'Chưa kết nối';
  row.append(selectLabel, keyLabel, actions, status);
  $('mappings').append(row);
}
async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const data = await message({ type: 'status' });
    projects = data.projects.filter((p) => !p.isArchived);
    if (!loaded) {
      $('server-url').value = data.config.serverUrl || '';
      $('username').value = data.config.username || '';
      data.config.mappings.forEach(addMapping);
      loaded = true;
    }
    $('overall-status').textContent = data.channels.length
      ? `${data.channels.filter((c) => c.status === 'online').length}/${data.channels.length} kết nối`
      : 'Chưa ghép nối';
    for (const row of $('mappings').children) {
      const channel = data.channels.find(
        (c) => c.localProjectId === row.querySelector('select').value,
      );
      if (channel)
        row.querySelector('.mapping-status').textContent =
          `${{ online: '🟢 Đã kết nối', connecting: 'Đang kết nối…', offline: '🔴 Offline', error: '⚠️ Lỗi' }[channel.status]} · ${channel.pending} thay đổi chờ gửi${channel.onlineUsers.length ? ' · ' + channel.onlineUsers.join(', ') : ''}${channel.error ? ' · ' + channel.error : ''}`;
    }
    $('activity').replaceChildren();
    for (const item of data.activity) {
      const li = document.createElement('li');
      li.textContent = `${new Date(item.timestamp).toLocaleTimeString()} · ${item.message}`;
      if (item.error) li.className = 'error';
      $('activity').append(li);
    }
    if (!data.activity.length) {
      const li = document.createElement('li');
      li.textContent = 'Chưa có hoạt động.';
      $('activity').append(li);
    }
  } catch (e) {
    feedback(e.message, true);
  } finally {
    pollBusy = false;
  }
}
$('add-mapping').onclick = () => {
  if (!projects.length) feedback('Tạo một dự án cục bộ trước.', true);
  else addMapping();
};
$('new-local-project').onclick = async () => {
  const title = prompt('Tên dự án cục bộ:');
  if (!title?.trim()) return;
  try {
    await message({ type: 'createProject', title });
    const data = await message({ type: 'status' });
    projects = data.projects.filter((p) => !p.isArchived);
    addMapping({ localProjectId: projects.find((p) => p.title === title.trim())?.id });
    feedback('Đã tạo dự án cục bộ.');
  } catch (e) {
    feedback(e.message, true);
  }
};
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  $('save').disabled = true;
  try {
    await message({
      type: 'save',
      serverUrl: $('server-url').value,
      username: $('username').value,
      mappings: [...$('mappings').children].map((row) => ({
        localProjectId: row.querySelector('select').value,
        apiKey: row.querySelector('input').value,
      })),
    });
    for (const key of document.querySelectorAll('.api-key')) {
      key.value = '';
      key.placeholder = 'Để trống để giữ key trên thiết bị';
    }
    feedback('Đã lưu. Đang đồng bộ các dự án…');
    await refresh();
  } catch (e) {
    feedback(e.message, true);
  } finally {
    $('save').disabled = false;
  }
};
$('force-sync').onclick = async () => {
  try {
    await message({ type: 'sync' });
    feedback('Đã yêu cầu đồng bộ lại.');
  } catch (e) {
    feedback(e.message, true);
  }
};
void refresh();
const poll = setInterval(refresh, 3000);
window.addEventListener('pagehide', () => clearInterval(poll));

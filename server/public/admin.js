'use strict';
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('xpsync-token'),
  setup = false,
  projects = [],
  selected,
  tasks = [],
  socket,
  reconnectTimer,
  toastTimer,
  refreshTimer,
  editing = false;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 6000);
}
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401 && !path.startsWith('/auth')) logout();
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Yêu cầu thất bại');
  return data;
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function date(ts) {
  return new Date(ts).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function duration(ms) {
  return `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
}
async function authState() {
  try {
    setup = (await api('/auth/status')).setupRequired;
    $('setup-label').hidden = !setup;
    $('setup-token').required = setup;
    $('auth-title').textContent = setup ? 'Bắt đầu cùng XPSync.' : 'Chào mừng trở lại.';
    $('auth-submit').textContent = setup ? 'Tạo quản trị viên' : 'Đăng nhập';
    $('auth-description').textContent = setup
      ? 'Tạo tài khoản quản trị đầu tiên. Mật khẩu tối thiểu 12 ký tự.'
      : 'Đăng nhập để quản lý không gian làm việc của nhóm.';
  } catch (e) {
    $('auth-error').textContent = e.message;
  }
}
$('auth-form').onsubmit = async (event) => {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('auth-error').textContent = '';
  try {
    const data = await api(setup ? '/auth/setup' : '/auth/login', {
      username: $('username').value,
      password: $('password').value,
      ...(setup ? { setupToken: $('setup-token').value } : {}),
    });
    token = data.token;
    sessionStorage.setItem('xpsync-token', token);
    $('password').value = '';
    $('setup-token').value = '';
    await enter();
  } catch (e) {
    $('auth-error').textContent = e.message;
  } finally {
    $('auth-submit').disabled = false;
  }
};
function logout() {
  token = null;
  selected = undefined;
  sessionStorage.removeItem('xpsync-token');
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  $('workspace').hidden = true;
  $('auth').hidden = false;
  void authState();
}
$('logout').onclick = logout;
async function enter() {
  await refresh();
  $('auth').hidden = true;
  $('workspace').hidden = false;
  connect();
}
function connect() {
  if (!token) return;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'admin:join', token }));
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'admin:ready') {
      $('live').textContent = 'Live sync';
      $('live').className = 'badge online';
      void refresh().catch((e) => toast(e.message));
    }
    if (msg.type === 'admin:changed') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh().catch((e) => toast(e.message)), 150);
    }
    if (msg.type === 'error') logout();
  };
  socket.onclose = () => {
    $('live').textContent = 'Đang kết nối lại';
    $('live').className = 'badge';
    reconnectTimer = setTimeout(connect, 3000);
  };
}
async function refresh() {
  projects = await api('/projects');
  $('project-count').textContent = projects.length;
  $('task-count').textContent = projects.reduce((sum, p) => sum + p.taskCount, 0);
  $('user-count').textContent = projects.reduce((sum, p) => sum + p.onlineUsers.length, 0);
  if (!projects.some((p) => p.id === selected)) selected = projects[0]?.id;
  $('projects').replaceChildren();
  if (!projects.length)
    $('projects').append(el('p', 'Chưa có dự án. Tạo dự án đầu tiên để kết nối nhóm.', 'empty'));
  for (const p of projects) {
    const card = el('button', undefined, 'project-card' + (p.id === selected ? ' active' : ''));
    card.append(
      el('span', '◈', 'card-icon'),
      el(
        'span',
        `${p.onlineUsers.length} online`,
        'badge' + (p.onlineUsers.length ? ' online' : ''),
      ),
      el('h3', p.name),
      el('p', p.description || 'Sẵn sàng kết nối Super Productivity', 'muted'),
    );
    const meta = el('div', undefined, 'project-meta');
    meta.append(el('span', `${p.taskCount} công việc`), el('span', date(p.created_at)));
    card.append(meta, el('code', p.key_prefix + '••••••••', 'project-key'));
    card.onclick = () => {
      selected = p.id;
      void refresh().catch((e) => toast(e.message));
    };
    $('projects').append(card);
  }
  $('inspector').hidden = !selected;
  if (!selected) return;
  const current = selected,
    project = projects.find((p) => p.id === current);
  const [list, logs] = await Promise.all([
    api(`/projects/${current}/tasks`),
    api(`/projects/${current}/logs`),
  ]);
  if (selected !== current) return;
  tasks = list;
  $('project-title').textContent = project.name;
  $('project-description').textContent = project.description;
  $('online-users').textContent = project.onlineUsers.length
    ? 'Đang online: ' + project.onlineUsers.join(', ')
    : 'Chưa có thành viên online';
  renderTasks();
  $('activity').replaceChildren();
  for (const log of logs) {
    const li = el('li');
    li.append(
      el('strong', log.user_name),
      el(
        'span',
        ` ${{ CREATE: 'đã tạo', UPDATE: 'đã cập nhật', DELETE: 'đã xóa' }[log.action]} “${log.task_title}”`,
      ),
      el('small', date(log.timestamp)),
    );
    $('activity').append(li);
  }
  if (!logs.length)
    $('activity').append(el('li', 'Hoạt động của nhóm sẽ xuất hiện tại đây.', 'muted'));
}
function renderTasks() {
  const filter = $('filter').value,
    visible = tasks.filter((t) => filter === 'all' || t.data.isDone === (filter === 'done'));
  $('tasks').replaceChildren();
  $('tasks-empty').hidden = !!visible.length;
  for (const t of visible) {
    const tr = el('tr'),
      title = el('td'),
      time = el('td'),
      updated = el('td');
    title.append(
      el(
        'strong',
        (t.data.parentId ? '↳ ' : '') + (t.data.isDone ? '✓ ' : '○ ') + t.data.title,
        t.data.isDone ? 'done' : '',
      ),
      el('small', t.data.isDone ? 'Đã hoàn thành' : 'Đang làm'),
    );
    title.title = t.data.notes;
    time.append(
      el('span', duration(t.data.timeSpent)),
      el('small', 'Ước tính ' + duration(t.data.timeEstimate)),
    );
    updated.append(el('span', t.lastUpdatedBy), el('small', date(t.updatedAt)));
    tr.append(title, time, updated);
    $('tasks').append(tr);
  }
}
$('filter').onchange = renderTasks;
function projectForm(edit) {
  editing = edit;
  const p = edit ? projects.find((p) => p.id === selected) : null;
  $('project-name').value = p?.name || '';
  $('description').value = p?.description || '';
  $('project-dialog-title').textContent = edit ? 'Chỉnh sửa dự án' : 'Tạo dự án mới';
  $('project-dialog').showModal();
}
$('new-project').onclick = () => projectForm(false);
$('edit-project').onclick = () => projectForm(true);
$('cancel-project').onclick = () => $('project-dialog').close();
function showKey(key) {
  $('new-key').value = key;
  $('new-key').type = 'password';
  $('key-dialog').showModal();
}
$('project-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const p = await api(
      editing ? `/projects/${selected}` : '/projects',
      { name: $('project-name').value, description: $('description').value },
      editing ? 'PATCH' : 'POST',
    );
    selected = p.id;
    $('project-dialog').close();
    if (p.apiKey) showKey(p.apiKey);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
$('rotate-key').onclick = async () => {
  if (!confirm('Đổi API key sẽ ngắt kết nối các thành viên. Tiếp tục?')) return;
  try {
    showKey((await api(`/projects/${selected}/regenerate-key`, {})).apiKey);
  } catch (e) {
    toast(e.message);
  }
};
$('delete-project').onclick = async () => {
  if (
    !confirm('Xóa dự án, task và lịch sử trên server? Dữ liệu trên máy thành viên sẽ được giữ lại.')
  )
    return;
  try {
    await api(`/projects/${selected}`, undefined, 'DELETE');
    selected = undefined;
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
$('show-key').onclick = () =>
  ($('new-key').type = $('new-key').type === 'password' ? 'text' : 'password');
$('copy-key').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('new-key').value);
    toast('Đã sao chép API key');
  } catch {
    $('new-key').type = 'text';
    $('new-key').select();
    toast('Chọn key rồi nhấn Ctrl+C để sao chép.');
  }
};
$('close-key').onclick = () => {
  $('new-key').value = '';
  $('key-dialog').close();
};
if (token)
  enter().catch((e) => {
    toast(e.message);
    logout();
  });
else void authState();

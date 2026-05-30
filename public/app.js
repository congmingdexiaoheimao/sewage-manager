// ==================== 初始化 ====================
const API = '';
let currentUser = null;
let currentToken = null;

// 检查登录
(function init() {
  currentToken = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  if (!currentToken || !userStr) { window.location.href = '/login.html'; return; }
  currentUser = JSON.parse(userStr);

  document.getElementById('sidebarAvatar').textContent = currentUser.name.slice(0, 2);
  document.getElementById('sidebarName').textContent = currentUser.name;
  document.getElementById('sidebarRole').textContent = currentUser.role;

  // 导航
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector('.sidebar-nav a.active')?.classList.remove('active');
      a.classList.add('active');
      loadPage(a.dataset.page);
    });
  });

  // 弹窗关闭
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  });

  loadPage('dashboard');
})();

function logout() {
  fetch(API + '/api/auth/logout', { method: 'POST', headers: authHeaders() })
    .catch(() => {});
  localStorage.clear();
  window.location.href = '/login.html';
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + currentToken, 'Content-Type': 'application/json' };
}

// ==================== Toast ====================
function toast(msg, type) {
  type = type || 'success';
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ==================== Modal ====================
function openModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
}

// ==================== 页面加载 ====================
async function loadPage(page) {
  const main = document.getElementById('mainContent');
  main.innerHTML = '<div class="loading">加载中...</div>';
  try {
    switch (page) {
      case 'dashboard': await renderDashboard(main); break;
      case 'tasks': await renderTasks(main); break;
      case 'stream': await renderStream(main); break;
      case 'daily': await renderTable(main, 'daily', '日常巡检', dailyFields()); break;
      case 'lab': await renderTable(main, 'lab', '化验室', labFields()); break;
      case 'inspect': await renderTable(main, 'inspect', '现场督检', inspectFields()); break;
      case 'users': await renderUsers(main); break;
      default: main.innerHTML = '<div class="empty">未知页面: ' + page + '</div>';
    }
  } catch(err) {
    main.innerHTML = '<div class="page-header"><h2>⚠️ 页面加载错误</h2></div>'
      + '<div class="card"><div class="card-body"><pre style="color:#e74c3c;white-space:pre-wrap;word-break:break-all;font-size:13px;">' + err.message + '\n\n' + (err.stack || '') + '</pre></div></div>';
  }
}

// ==================== Dashboard ====================
async function renderDashboard(main) {
  main.innerHTML = '<div class="page-header"><h2>数据总览</h2><p>近期污水处理运行数据统计</p></div>'
    + '<div class="info-ticker" id="infoTicker"><div class="info-ticker-label">📡 实时动态</div><div class="info-ticker-wrap"><div class="info-ticker-track" id="tickerTrack"><span style="color:rgba(255,255,255,0.4);padding:0 20px;">加载中...</span></div></div></div>'
    + '<div class="stats-grid" id="statsGrid"><div class="loading">加载中...</div></div>'
    + '<div class="card"><div class="card-header"><h3>📝 待处理任务</h3><a href="#" style="font-size:13px;color:#4facfe;" onclick="document.querySelector(\'.sidebar-nav a[data-page=tasks]\').click()">查看全部 →</a></div><div class="card-body no-padding" id="dashTasks"><div class="loading">加载中...</div></div></div>'
    + '<div class="card"><div class="card-body"><div id="quickActions" style="display:flex;gap:12px;flex-wrap:wrap;"></div></div></div>'
    + '<div class="card" style="margin-top:16px;"><div class="card-header"><h3>操作日志</h3></div><div class="card-body no-padding"><div class="table-wrapper" id="logTable"></div></div></div>';

  try {
    const res = await fetch(API + '/api/stats/summary?days=7', { headers: authHeaders() });
    const data = await res.json();

    let totalInflow = 0, totalOutflow = 0, totalLab = 0, avgCod = 0;
    let codCount = 0;
    data.forEach(d => {
      totalInflow += d.inflow || 0;
      totalOutflow += d.outflow || 0;
      if (d.outCod) { avgCod += d.outCod; codCount++; }
    });
    if (codCount > 0) avgCod = (avgCod / codCount).toFixed(1);

    // count records
    const [dr, lr, ir] = await Promise.all([
      fetch(API + '/api/daily', { headers: authHeaders() }).then(r => r.json()),
      fetch(API + '/api/lab', { headers: authHeaders() }).then(r => r.json()),
      fetch(API + '/api/inspect', { headers: authHeaders() }).then(r => r.json())
    ]);
    totalLab = lr.length;
    const qualified = lr.filter(r => r.conclusion === '达标').length;

    document.getElementById('statsGrid').innerHTML = [
      { v: dr.length, l: '日常巡检记录', cls: '' },
      { v: lr.length, l: '化验室记录', cls: 'accent' },
      { v: ir.length, l: '现场督检记录', cls: '' },
      { v: totalInflow.toFixed(0) + ' m³', l: '累计进水总量', cls: '' },
      { v: avgCod + ' mg/L', l: '平均出水COD', cls: avgCod > 60 ? 'danger' : 'accent' },
      { v: qualified + ' / ' + totalLab, l: '化验达标率', cls: qualified / Math.max(totalLab,1) < 0.9 ? 'warning' : 'accent' }
    ].map(s => '<div class="stat-card ' + s.cls + '"><div class="stat-value">' + s.v + '</div><div class="stat-label">' + s.l + '</div></div>').join('');

    // 加载实时信息滚动条
    try {
      const streamRes = await fetch(API + '/api/stream', { headers: authHeaders() });
      const streamData = await streamRes.json();
      buildTicker(streamData.items || []);
    } catch { document.getElementById('tickerTrack').innerHTML = '<span style="color:rgba(255,255,255,0.4);padding:0 20px;">动态加载失败</span>'; }

    document.getElementById('quickActions').innerHTML = [
      { text: '生成演示数据', icon: '📥', action: seedData },
      { text: '新增巡检记录', icon: '✏️', action: () => { showForm('daily', '日常巡检', dailyFields()); } },
      { text: '新增化验记录', icon: '🧪', action: () => { showForm('lab', '化验室', labFields()); } },
      { text: '新增督检记录', icon: '🔍', action: () => { showForm('inspect', '现场督检', inspectFields()); } },
      { text: '新增任务', icon: '➕', action: () => { showTaskForm(); } },
    ].map(b => '<button class="btn btn-outline" onclick="(' + b.action.toString() + ')()">' + b.icon + ' ' + b.text + '</button>').join('');

    // 加载待办任务
    try {
      const tRes = await fetch(API + '/api/tasks', { headers: authHeaders() });
      const tasks = await tRes.json();
      const pending = (tasks || []).filter(t => t.status !== '已完成');
      const highPending = pending.filter(t => t.priority === '高');
      const todayPending = pending.filter(t => t.deadline === new Date().toISOString().slice(0, 10));

      if (pending.length === 0) {
        document.getElementById('dashTasks').innerHTML = '<div class="empty">暂无待处理任务</div>';
      } else {
        let taskHtml = '<div style="padding:12px 16px;display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid #e8e8e8;">';
        taskHtml += '<div style="font-size:13px;color:#666;">待处理: <b style="color:#e74c3c;font-size:16px;">' + pending.length + '</b></div>';
        taskHtml += '<div style="font-size:13px;color:#666;">高优先级: <b style="color:#e74c3c;">' + highPending.length + '</b></div>';
        taskHtml += '<div style="font-size:13px;color:#666;">今日截止: <b style="color:#f39c12;">' + todayPending.length + '</b></div>';
        taskHtml += '</div>';
        taskHtml += '<table style="margin:0;"><thead><tr><th>任务</th><th>类型</th><th>优先级</th><th>状态</th><th>负责人</th><th>截止日期</th></tr></thead><tbody>';
        pending.slice(0, 5).forEach(t => {
          const pBadge = t.priority === '高' ? 'badge-danger' : t.priority === '中' ? 'badge-warning' : 'badge-info';
          const sBadge = t.status === '待处理' ? 'badge-info' : 'badge-warning';
          const typeIcon = { '巡检': '📋', '化验': '🧪', '督检': '🔍', '设备': '🔧', '审核': '✅' }[t.type] || '📌';
          taskHtml += '<tr>';
          taskHtml += '<td><b>' + typeIcon + ' ' + t.title + '</b></td>';
          taskHtml += '<td>' + t.type + '</td>';
          taskHtml += '<td><span class="badge ' + pBadge + '">' + t.priority + '</span></td>';
          taskHtml += '<td><span class="badge ' + sBadge + '">' + t.status + '</span></td>';
          taskHtml += '<td>' + (t.assignedTo || '-') + '</td>';
          taskHtml += '<td>' + (t.deadline || '-') + '</td>';
          taskHtml += '</tr>';
        });
        if (pending.length > 5) taskHtml += '<tr><td colspan="6" style="text-align:center;color:#999;">还有 ' + (pending.length - 5) + ' 个待处理任务...</td></tr>';
        taskHtml += '</tbody></table>';
        document.getElementById('dashTasks').innerHTML = taskHtml;
      }
    } catch { document.getElementById('dashTasks').innerHTML = '<div class="loading">任务加载失败</div>'; }

    // log
    try {
      const logRes = await fetch(API + '/api/exportLog', { headers: authHeaders() });
      const logs = await logRes.json();
      document.getElementById('logTable').innerHTML = logs.length === 0
        ? '<div class="empty">暂无操作记录</div>'
        : '<table><thead><tr><th>时间</th><th>操作</th><th>操作人</th></tr></thead><tbody>'
        + logs.slice(-10).reverse().map(l => '<tr><td>' + new Date(l.createTime).toLocaleString('zh-CN') + '</td><td>' + (l.action || '-') + '</td><td>' + (l.reporter || '-') + '</td></tr>').join('')
        + '</tbody></table>';
    } catch { document.getElementById('logTable').innerHTML = '<div class="empty">暂无操作记录</div>'; }
  } catch (err) {
    main.innerHTML += '<div class="loading">数据加载失败: ' + err.message + '</div>';
  }
}

// ==================== 通用表格页 ====================
function dailyFields() {
  return [
    { key: 'date', label: '日期', type: 'date', required: true },
    { key: 'shift', label: '班次', type: 'select', options: ['早班(0:00-8:00)', '中班(8:00-16:00)', '晚班(16:00-24:00)'], required: true },
    { key: 'inflow', label: '进水量(m³)', type: 'number' },
    { key: 'outflow', label: '出水量(m³)', type: 'number' },
    { key: 'inCod', label: '进水COD(mg/L)', type: 'number' },
    { key: 'outCod', label: '出水COD(mg/L)', type: 'number' },
    { key: 'inNh3', label: '进水氨氮(mg/L)', type: 'number' },
    { key: 'outNh3', label: '出水氨氮(mg/L)', type: 'number' },
    { key: 'inTn', label: '进水总氮(mg/L)', type: 'number' },
    { key: 'outTn', label: '出水总氮(mg/L)', type: 'number' },
    { key: 'inTp', label: '进水总磷(mg/L)', type: 'number' },
    { key: 'outTp', label: '出水总磷(mg/L)', type: 'number' },
    { key: 'mlss', label: 'MLSS(mg/L)', type: 'number' },
    { key: 'do_', label: 'DO(mg/L)', type: 'number' },
    { key: 'chemi', label: '药剂用量(kg)', type: 'number' },
    { key: 'remark', label: '备注', type: 'text' },
  ];
}

function labFields() {
  return [
    { key: 'date', label: '日期', type: 'date', required: true },
    { key: 'type', label: '类型', type: 'select', options: ['进出水', '过程水', '污泥'], required: true },
    { key: 'samplePoint', label: '采样点', type: 'text', required: true },
    { key: 'cod', label: 'COD(mg/L)', type: 'number' },
    { key: 'bod', label: 'BOD(mg/L)', type: 'number' },
    { key: 'ss', label: 'SS(mg/L)', type: 'number' },
    { key: 'nh3', label: '氨氮(mg/L)', type: 'number' },
    { key: 'tn', label: '总氮(mg/L)', type: 'number' },
    { key: 'tp', label: '总磷(mg/L)', type: 'number' },
    { key: 'ph', label: 'pH', type: 'number' },
    { key: 'turbidity', label: '浊度(NTU)', type: 'number' },
    { key: 'color_', label: '色度(倍)', type: 'number' },
    { key: 'mlss', label: 'MLSS(mg/L)', type: 'number' },
    { key: 'sv', label: 'SV(%)', type: 'number' },
    { key: 'svi', label: 'SVI', type: 'number' },
    { key: 'conclusion', label: '结论', type: 'select', options: ['达标', '不达标', '接近限值'] },
    { key: 'remark', label: '备注', type: 'text' },
  ];
}

function inspectFields() {
  return [
    { key: 'date', label: '日期', type: 'date', required: true },
    { key: 'time', label: '时间', type: 'text', required: true },
    { key: 'location', label: '巡检位置', type: 'select', options: ['格栅间','沉砂池','初沉池','曝气池A','曝气池B','二沉池','污泥泵房','回流泵房','加药间','鼓风机房','总出水口'], required: true },
    { key: 'equipStatus', label: '设备状态', type: 'select', options: ['正常', '备用', '异常'], required: true },
    { key: 'level', label: '液位(m)', type: 'number' },
    { key: 'temp', label: '温度(°C)', type: 'number' },
    { key: 'noise', label: '噪音(dB)', type: 'text' },
    { key: 'vibration', label: '振动', type: 'select', options: ['正常', '异常'] },
    { key: 'abnormType', label: '异常类型', type: 'select', options: ['','设备漏水','噪音异常','液位偏高','曝气异常'] },
    { key: 'desc', label: '描述', type: 'text' },
    { key: 'action', label: '处理措施', type: 'text' },
  ];
}

async function renderTable(main, type, title, fields) {
  main.innerHTML = '<div class="page-header"><h2>' + title + '</h2><p>管理' + title + '数据</p></div>'
    + '<div class="toolbar"><button class="btn btn-primary" onclick="showForm(\'' + type + '\', \'' + title + '\', fields_' + type + ')">+ 新增</button><input type="date" id="filterDate" placeholder="按日期筛选" onchange="filter' + capitalize(type) + '()"><input type="text" id="filterSearch" placeholder="搜索..." oninput="filter' + capitalize(type) + '()"></div>';

  // store fields globally for form access
  window['fields_' + type] = fields;
  window['_type'] = type;
  window['_title'] = title;

  await loadData(type);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function loadData(type) {
  const main = document.getElementById('mainContent');
  const card = main.querySelector('.card');
  if (card) card.remove();

  try {
    const res = await fetch(API + '/api/' + type, { headers: authHeaders() });
    const data = await res.json();
    if (!Array.isArray(data)) return;

    window['_data'] = data;
    renderDataTable(type, data);
  } catch (err) {
    main.innerHTML += '<div class="loading">加载失败</div>';
  }
}

function renderDataTable(type, data) {
  const main = document.getElementById('mainContent');
  const old = main.querySelector('.card');
  if (old) old.remove();

  if (data.length === 0) {
    main.innerHTML += '<div class="card"><div class="card-body"><div class="empty">暂无数据，点击"+ 新增"添加</div></div></div>';
    return;
  }

  const visible = data.slice(0, 50);
  const headers = Object.keys(visible[0]).filter(k => k !== 'password');
  const maxHeaders = 10;
  const displayHeaders = headers.slice(0, maxHeaders);

  let html = '<div class="card"><div class="card-header"><h3>共 ' + data.length + ' 条记录</h3><span style="font-size:12px;color:#999">显示最近' + Math.min(data.length, 50) + '条</span></div>';
  html += '<div class="card-body no-padding"><div class="table-wrapper"><table><thead><tr>';
  displayHeaders.forEach(h => html += '<th>' + h + '</th>');
  html += '<th>操作</th></tr></thead><tbody>';

  visible.forEach(row => {
    html += '<tr>';
    displayHeaders.forEach(h => {
      let val = row[h];
      if (val === null || val === undefined) val = '-';
      if (typeof val === 'object') val = JSON.stringify(val);
      if (h === 'conclusion') {
        let badge = 'badge-info';
        if (val === '达标') badge = 'badge-success';
        else if (val === '不达标') badge = 'badge-danger';
        else if (val === '接近限值') badge = 'badge-warning';
        val = '<span class="badge ' + badge + '">' + val + '</span>';
      }
      if (h === 'equipStatus') {
        let badge = 'badge-success';
        if (val === '异常') badge = 'badge-danger';
        else if (val === '备用') badge = 'badge-warning';
        val = '<span class="badge ' + badge + '">' + val + '</span>';
      }
      if (h === 'createTime' || h === 'date') {
        if (typeof val === 'string' && val.includes('T')) val = val.slice(0, 10);
      }
      html += '<td>' + val + '</td>';
    });
    html += '<td><button class="btn btn-sm btn-danger" onclick="deleteRecord(\'' + type + '\',\'' + row.id + '\')">删除</button></td></tr>';
  });

  html += '</tbody></table></div></div></div>';
  main.innerHTML += html;
}

function filterData(type) {
  const dateFilter = document.getElementById('filterDate')?.value;
  const searchFilter = document.getElementById('filterSearch')?.value?.toLowerCase() || '';
  let data = window['_data'] || [];

  if (dateFilter) data = data.filter(r => r.date === dateFilter);
  if (searchFilter) {
    data = data.filter(r => Object.values(r).some(v => {
      if (v === null || v === undefined) return false;
      return String(v).toLowerCase().includes(searchFilter);
    }));
  }
  renderDataTable(type, data);
}

// register filter functions
window.filterDaily = function() { filterData('daily'); };
window.filterLab = function() { filterData('lab'); };
window.filterInspect = function() { filterData('inspect'); };
window.filterUsers = function() { filterData('users'); };

async function deleteRecord(type, id) {
  if (!confirm('确定删除此记录？')) return;
  try {
    const res = await fetch(API + '/api/' + type + '/' + id, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) {
      toast('删除成功');
      if (type === 'tasks') {
        const main = document.getElementById('mainContent');
        renderTasks(main);
      } else {
        loadData(type);
      }
    }
    else toast('删除失败', 'error');
  } catch { toast('网络错误', 'error'); }
}

// ==================== 表单弹窗 ====================
function showForm(type, title, fields) {
  let html = '<div class="modal-header"><h3>新增' + title + '</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<form onsubmit="saveForm(event,\'' + type + '\', fields_' + type + ')"><div class="modal-body">';
  fields.forEach(f => {
    html += '<div class="form-group"><label>' + f.label + (f.required ? ' <span style="color:red">*</span>' : '') + '</label>';
    if (f.type === 'select') {
      html += '<select name="' + f.key + '"' + (f.required ? ' required' : '') + '>';
      html += '<option value="">请选择</option>';
      (f.options || []).forEach(o => html += '<option value="' + o + '">' + o + '</option>');
      html += '</select>';
    } else if (f.type === 'date') {
      html += '<input type="' + f.type + '" name="' + f.key + '" value="' + new Date().toISOString().slice(0,10) + '"' + (f.required ? ' required' : '') + '>';
    } else {
      html += '<input type="' + f.type + '" name="' + f.key + '" step="any" placeholder="请输入' + f.label + '"' + (f.required ? ' required' : '') + '>';
    }
    html += '</div>';
  });
  html += '</div><div class="modal-footer"><button type="button" class="btn btn-outline" onclick="closeModal()">取消</button><button type="submit" class="btn btn-primary">保存</button></div></form>';
  openModal(html);
}

async function saveForm(e, type, fields) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const record = {};
  fields.forEach(f => {
    const val = fd.get(f.key);
    if (val !== '' && val !== null) {
      record[f.key] = f.type === 'number' ? parseFloat(val) : val;
    }
  });
  record.id = type[0] + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  record.createTime = new Date().toISOString();
  record.reporter = currentUser.name;
  record.reporterRole = currentUser.role;
  record.status = '已完成';
  record.reviewComment = '';

  try {
    const res = await fetch(API + '/api/' + type, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(record)
    });
    const data = await res.json();
    if (data.success) {
      toast('保存成功');
      closeModal();
      loadData(type);
    } else {
      toast('保存失败: ' + (data.error || ''), 'error');
    }
  } catch (err) {
    toast('网络错误', 'error');
  }
}

// ==================== 实时信息流 ====================
function buildTicker(items) {
  const track = document.getElementById('tickerTrack');
  if (!track) return;
  if (!items || items.length === 0) {
    track.innerHTML = '<span style="color:rgba(255,255,255,0.4);padding:0 20px;">暂无动态</span>';
    return;
  }

  const tagClass = { '异常': 'anomaly', '报送': 'submit', '动态': 'dynamic' };
  let html = '';
  // 双份实现无缝滚动
  for (let loop = 0; loop < 2; loop++) {
    items.slice(0, 20).forEach((item, i) => {
      const timeStr = item.time ? new Date(item.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      html += '<div class="info-ticker-item" onclick="document.querySelector(\'.sidebar-nav a[data-page=' + (item.link || 'stream') + ']\').click()" title="' + item.detail + '">';
      html += '<span class="ticker-tag ' + (tagClass[item.type] || '') + '">' + (item.tag || item.type) + '</span>';
      html += '<span style="color:#fff;">' + item.icon + ' ' + item.title + '</span>';
      html += '<span style="color:rgba(255,255,255,0.4);font-size:11px;">' + (item.reporter || '') + '</span>';
      html += '<span class="ticker-time">' + timeStr + '</span>';
      html += '</div>';
      if (i < items.length - 1) html += '<div class="ticker-sep"></div>';
    });
  }
  track.innerHTML = html;
}

async function renderStream(main) {
  main.innerHTML = '<div class="page-header"><h2>📡 信息动态</h2><p>实时汇集异常报警、数据报送、任务动态等</p></div>'
    + '<div class="stream-stats" id="streamStats"><div class="loading">加载中...</div></div>'
    + '<div class="stream-filters" id="streamFilters"></div>'
    + '<div class="card"><div class="card-header"><h3>动态列表</h3><span style="font-size:12px;color:#999;" id="streamCount"></span></div><div class="card-body no-padding" id="streamList"><div class="loading">加载中...</div></div></div>';

  try {
    const res = await fetch(API + '/api/stream', { headers: authHeaders() });
    const data = await res.json();
    const items = data.items || [];
    window['_streamItems'] = items;

    // 统计
    const anomalyCount = items.filter(i => i.type === '异常').length;
    const submitCount = items.filter(i => i.type === '报送').length;
    const dynamicCount = items.filter(i => i.type === '动态').length;
    document.getElementById('streamStats').innerHTML =
      '<div class="stream-stat anomaly"><div class="ss-val">' + anomalyCount + '</div><div class="ss-label">⚠️ 异常/报警</div></div>'
      + '<div class="stream-stat submit"><div class="ss-val">' + submitCount + '</div><div class="ss-label">📤 数据报送</div></div>'
      + '<div class="stream-stat dynamic"><div class="ss-val">' + dynamicCount + '</div><div class="ss-label">🔄 任务动态</div></div>';

    // 过滤器
    document.getElementById('streamFilters').innerHTML = [
      { label: '全部', type: '' },
      { label: '⚠️ 异常', type: '异常' },
      { label: '📤 报送', type: '报送' },
      { label: '🔄 动态', type: '动态' },
    ].map(f => '<div class="stream-filter-chip' + (f.type === '' ? ' active' : '') + '" data-filter="' + f.type + '" onclick="filterStream(\'' + f.type + '\')">' + f.label + '</div>').join('');

    document.getElementById('streamCount').textContent = '共 ' + items.length + ' 条';
    renderStreamItems(items);
  } catch { main.innerHTML += '<div class="loading">加载失败</div>'; }
}

function filterStream(type) {
  document.querySelectorAll('.stream-filter-chip').forEach(c => c.classList.remove('active'));
  const chip = document.querySelector('.stream-filter-chip[data-filter="' + type + '"]');
  if (chip) chip.classList.add('active');
  const items = window['_streamItems'] || [];
  const filtered = type ? items.filter(i => i.type === type) : items;
  document.getElementById('streamCount').textContent = '共 ' + filtered.length + ' 条';
  renderStreamItems(filtered);
}

function renderStreamItems(items) {
  const container = document.getElementById('streamList');
  if (items.length === 0) {
    container.innerHTML = '<div class="empty">暂无相关动态</div>';
    return;
  }

  let html = '<div class="timeline">';
  items.forEach(item => {
    const timeStr = item.time ? new Date(item.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    html += '<div class="timeline-item ' + item.type + '" onclick="document.querySelector(\'.sidebar-nav a[data-page=' + (item.link || 'stream') + ']\').click()" style="cursor:pointer;">';
    html += '<div class="tl-icon">' + item.icon + '</div>';
    html += '<div class="tl-body">';
    html += '<div class="tl-title">' + item.title + '</div>';
    html += '<div class="tl-detail">' + item.detail + '</div>';
    html += '<div class="tl-meta">';
    html += '<span class="tl-tag ' + item.type + (item.level === 'high' ? ' high' : '') + '">' + (item.tag || item.type) + '</span>';
    html += '<span>' + timeStr + '</span>';
    html += '<span>👤 ' + (item.reporter || '-') + '</span>';
    html += '</div></div></div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ==================== 种子数据 ====================
async function seedData() {
  if (!confirm('将生成30天演示数据（每日巡检、化验、督检），继续？')) return;
  try {
    const res = await fetch(API + '/api/seed', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (data.success) {
      toast('生成完成：巡检' + data.counts.daily + '条、化验' + data.counts.lab + '条、督检' + data.counts.inspect + '条、任务' + (data.counts.tasks || 0) + '条');
      loadPage('dashboard');
    } else {
      toast('生成失败', 'error');
    }
  } catch { toast('网络错误', 'error'); }
}

// ==================== 任务管理 ====================
async function renderTasks(main) {
  main.innerHTML = '<div class="page-header"><h2>待办任务</h2><p>管理和跟踪污水处理厂各项工作任务</p></div>'
    + '<div class="toolbar"><button class="btn btn-primary" onclick="showTaskForm()">+ 新增任务</button>'
    + '<select id="taskFilter" onchange="filterTasks()"><option value="">全部状态</option><option value="待处理">待处理</option><option value="处理中">处理中</option><option value="已完成">已完成</option></select>'
    + '<select id="taskPriority" onchange="filterTasks()"><option value="">全部优先级</option><option value="高">高优先级</option><option value="中">中优先级</option><option value="低">低优先级</option></select></div>';

  try {
    const res = await fetch(API + '/api/tasks', { headers: authHeaders() });
    let tasks = await res.json();
    if (!Array.isArray(tasks)) tasks = [];
    window['_tasks'] = tasks;
    renderTaskTable(tasks);
  } catch (err) {
    main.innerHTML += '<div class="loading">任务加载失败</div>';
  }
}

function filterTasks() {
  const statusFilter = document.getElementById('taskFilter')?.value || '';
  const priorityFilter = document.getElementById('taskPriority')?.value || '';
  let tasks = window['_tasks'] || [];
  if (statusFilter) tasks = tasks.filter(t => t.status === statusFilter);
  if (priorityFilter) tasks = tasks.filter(t => t.priority === priorityFilter);
  renderTaskTable(tasks);
}

function renderTaskTable(tasks) {
  const main = document.getElementById('mainContent');
  const old = main.querySelector('.card');
  if (old) old.remove();

  const pending = tasks.filter(t => t.status !== '已完成');
  const high = pending.filter(t => t.priority === '高');
  const overdue = pending.filter(t => t.deadline && t.deadline < new Date().toISOString().slice(0, 10));

  let summaryHtml = '<div class="card"><div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap;padding:16px 20px;">';
  summaryHtml += '<div style="font-size:14px;">待处理: <b style="color:#e74c3c;font-size:20px;">' + pending.length + '</b></div>';
  summaryHtml += '<div style="font-size:14px;">高优先级: <b style="color:#e74c3c;font-size:20px;">' + high.length + '</b></div>';
  summaryHtml += '<div style="font-size:14px;">已逾期: <b style="color:#e74c3c;font-size:20px;">' + overdue.length + '</b></div>';
  summaryHtml += '<div style="font-size:14px;">已完成: <b style="color:#27ae60;font-size:20px;">' + (tasks.length - pending.length) + '</b></div>';
  summaryHtml += '</div></div>';
  main.innerHTML += summaryHtml;

  if (tasks.length === 0) {
    main.innerHTML += '<div class="card"><div class="card-body"><div class="empty">暂无任务，点击"+ 新增任务"添加</div></div></div>';
    return;
  }

  const sorted = [...tasks].sort((a, b) => {
    const pOrder = { '高': 0, '中': 1, '低': 2 };
    const sOrder = { '待处理': 0, '处理中': 1, '已完成': 2 };
    return (pOrder[a.priority] || 9) - (pOrder[b.priority] || 9) || (sOrder[a.status] || 9) - (sOrder[b.status] || 9);
  });

  let html = '<div class="card"><div class="card-header"><h3>共 ' + tasks.length + ' 条任务</h3></div>';
  html += '<div class="card-body no-padding"><div class="table-wrapper"><table><thead><tr>';
  html += '<th>任务名称</th><th>类型</th><th>优先级</th><th>状态</th><th>负责人</th><th>截止日期</th><th>备注</th><th>操作</th>';
  html += '</tr></thead><tbody>';

  sorted.forEach(t => {
    const pBadge = t.priority === '高' ? 'badge-danger' : t.priority === '中' ? 'badge-warning' : 'badge-info';
    const sBadge = t.status === '已完成' ? 'badge-success' : t.status === '处理中' ? 'badge-warning' : 'badge-info';
    const typeIcon = { '巡检': '📋', '化验': '🧪', '督检': '🔍', '设备': '🔧', '审核': '✅' }[t.type] || '📌';
    const isOverdue = t.deadline && t.deadline < new Date().toISOString().slice(0, 10) && t.status !== '已完成';
    html += '<tr' + (isOverdue ? ' style="background:#fff5f5;"' : '') + '>';
    html += '<td><b>' + typeIcon + ' ' + t.title + '</b>' + (isOverdue ? ' <span style="color:#e74c3c;font-size:11px;">⚠已逾期</span>' : '') + '</td>';
    html += '<td>' + t.type + '</td>';
    html += '<td><span class="badge ' + pBadge + '">' + t.priority + '</span></td>';
    html += '<td><span class="badge ' + sBadge + '">' + t.status + '</span></td>';
    html += '<td>' + (t.assignedTo || '-') + '</td>';
    html += '<td' + (isOverdue ? ' style="color:#e74c3c;font-weight:bold;"' : '') + '>' + (t.deadline || '-') + '</td>';
    html += '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (t.remark || '') + '">' + (t.remark || '-') + '</td>';
    html += '<td style="white-space:nowrap;">';
    if (t.status === '待处理') {
      html += '<button class="btn btn-sm btn-outline" style="color:#f39c12;border-color:#f39c12;" onclick="updateTaskStatus(\'' + t.id + '\',\'处理中\')">开始处理</button> ';
    }
    if (t.status === '处理中') {
      html += '<button class="btn btn-sm btn-outline" style="color:#27ae60;border-color:#27ae60;" onclick="updateTaskStatus(\'' + t.id + '\',\'已完成\')">标记完成</button> ';
    }
    if (t.status === '已完成') {
      html += '<button class="btn btn-sm btn-outline" style="color:#3498db;border-color:#3498db;" onclick="updateTaskStatus(\'' + t.id + '\',\'待处理\')">重新打开</button> ';
    }
    html += '<button class="btn btn-sm btn-danger" onclick="deleteRecord(\'tasks\',\'' + t.id + '\')">删除</button>';
    html += '</td></tr>';
  });

  html += '</tbody></table></div></div></div>';
  main.innerHTML += html;
}

async function updateTaskStatus(id, newStatus) {
  try {
    await fetch(API + '/api/tasks/' + id, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ status: newStatus })
    });
    toast('任务状态已更新');
    const main = document.getElementById('mainContent');
    if (document.querySelector('.sidebar-nav a.active')?.dataset?.page === 'tasks') {
      renderTasks(main);
    } else {
      renderDashboard(main);
    }
  } catch { toast('操作失败', 'error'); }
}

function showTaskForm() {
  const types = ['巡检', '化验', '督检', '设备', '审核'];
  const priorities = ['高', '中', '低'];
  const users = ['YY001', 'YY002', 'YY003', 'YY004', 'HYY001', 'HYZZ001', 'HTGL001', 'FCZ001'];
  let html = '<div class="modal-header"><h3>新增任务</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<form onsubmit="saveTask(event)"><div class="modal-body">';
  html += '<div class="form-group"><label>任务名称 <span style="color:red">*</span></label><input type="text" name="title" required placeholder="请输入任务名称"></div>';
  html += '<div class="form-group"><label>任务类型 <span style="color:red">*</span></label><select name="type" required><option value="">请选择</option>';
  types.forEach(t => html += '<option value="' + t + '">' + t + '</option>');
  html += '</select></div>';
  html += '<div class="form-group"><label>优先级 <span style="color:red">*</span></label><select name="priority" required><option value="">请选择</option>';
  priorities.forEach(p => html += '<option value="' + p + '">' + p + '</option>');
  html += '</select></div>';
  html += '<div class="form-group"><label>负责人</label><select name="assignedTo"><option value="">请选择</option>';
  users.forEach(u => html += '<option value="' + u + '">' + u + '</option>');
  html += '</select></div>';
  html += '<div class="form-group"><label>截止日期 <span style="color:red">*</span></label><input type="date" name="deadline" required value="' + new Date().toISOString().slice(0, 10) + '"></div>';
  html += '<div class="form-group"><label>备注</label><textarea name="remark" rows="3" placeholder="任务详细说明..." style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;"></textarea></div>';
  html += '</div><div class="modal-footer"><button type="button" class="btn btn-outline" onclick="closeModal()">取消</button><button type="submit" class="btn btn-primary">保存</button></div></form>';
  openModal(html);
}

async function saveTask(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const task = {
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title: fd.get('title'),
    type: fd.get('type'),
    priority: fd.get('priority'),
    status: '待处理',
    assignedTo: fd.get('assignedTo') || '',
    deadline: fd.get('deadline'),
    remark: fd.get('remark') || '',
    createTime: new Date().toISOString(),
  };
  try {
    const res = await fetch(API + '/api/tasks', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(task)
    });
    const data = await res.json();
    if (data.success) {
      toast('任务创建成功');
      closeModal();
      const main = document.getElementById('mainContent');
      if (document.querySelector('.sidebar-nav a.active')?.dataset?.page === 'tasks') {
        renderTasks(main);
      } else {
        renderDashboard(main);
      }
    } else {
      toast('创建失败', 'error');
    }
  } catch { toast('网络错误', 'error'); }
}

// ==================== 用户管理 ====================
async function renderUsers(main) {
  main.innerHTML = '<div class="page-header"><h2>用户管理</h2><p>管理系统用户账号和权限</p></div>'
    + '<div class="toolbar"><button class="btn btn-primary" onclick="showUserForm()">+ 新增用户</button><input type="text" id="filterSearch" placeholder="搜索用户..." oninput="filterUsers()"></div>';

  try {
    const res = await fetch(API + '/api/users', { headers: authHeaders() });
    const users = await res.json();
    window['_data'] = users;
    renderUserTable(users);
  } catch { main.innerHTML += '<div class="loading">加载失败</div>'; }
}

function renderUserTable(users) {
  const main = document.getElementById('mainContent');
  const old = main.querySelector('.card');
  if (old) old.remove();

  let html = '<div class="card"><div class="card-header"><h3>共 ' + users.length + ' 个用户</h3></div>';
  html += '<div class="card-body no-padding"><div class="table-wrapper"><table><thead><tr><th>序号</th><th>用户名</th><th>角色</th><th>密码</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  users.forEach((u, i) => {
    html += '<tr><td>' + (i + 1) + '</td><td>' + u.name + '</td><td>' + u.role + '</td><td>' + u.password + '</td>';
    html += '<td><span class="badge ' + (u.active ? 'badge-success' : 'badge-danger') + '">' + (u.active ? '激活' : '禁用') + '</span></td>';
    html += '<td><button class="btn btn-sm btn-outline" onclick="toggleUser(\'' + u.id + '\',' + u.active + ')">' + (u.active ? '禁用' : '启用') + '</button> ';
    html += '<button class="btn btn-sm btn-danger" onclick="deleteRecord(\'users\',\'' + u.id + '\')">删除</button></td></tr>';
  });
  html += '</tbody></table></div></div></div>';
  main.innerHTML += html;
}

async function toggleUser(id, active) {
  try {
    await fetch(API + '/api/users/' + id, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ active: !active })
    });
    toast('操作成功');
    loadPage('users');
  } catch { toast('操作失败', 'error'); }
}

function showUserForm() {
  const roles = ['管理员', '技术管理员', '审核员', '化验审核员', '化验员', '填报员', '查看员'];
  let html = '<div class="modal-header"><h3>新增用户</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<form onsubmit="saveUser(event)"><div class="modal-body">';
  html += '<div class="form-group"><label>用户名 <span style="color:red">*</span></label><input type="text" name="name" required placeholder="请输入用户名"></div>';
  html += '<div class="form-group"><label>密码 <span style="color:red">*</span></label><input type="text" name="password" required placeholder="请输入密码"></div>';
  html += '<div class="form-group"><label>角色 <span style="color:red">*</span></label><select name="role" required><option value="">请选择</option>';
  roles.forEach(r => html += '<option value="' + r + '">' + r + '</option>');
  html += '</select></div></div><div class="modal-footer"><button type="button" class="btn btn-outline" onclick="closeModal()">取消</button><button type="submit" class="btn btn-primary">保存</button></div></form>';
  openModal(html);
}

async function saveUser(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const user = {
    id: 'u' + (Date.now() % 100000),
    name: fd.get('name'),
    password: fd.get('password'),
    role: fd.get('role'),
    active: true
  };
  try {
    const res = await fetch(API + '/api/users', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(user)
    });
    const data = await res.json();
    if (data.success) { toast('用户创建成功'); closeModal(); loadPage('users'); }
    else toast('创建失败', 'error');
  } catch { toast('网络错误', 'error'); }
}
